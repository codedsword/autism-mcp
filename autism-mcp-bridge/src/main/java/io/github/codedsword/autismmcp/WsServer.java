// SPDX-License-Identifier: GPL-3.0-only
// Part of autism-mcp-bridge, an addon for AUTISM Client (https://github.com/codedsword/autism-mcp). GPL-3.0.
package io.github.codedsword.autismmcp;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

/**
 * Minimal single-client RFC 6455 WebSocket server. Binds 127.0.0.1 only, refuses non-loopback peers and
 * connections that do not present the session token (header x-autism-token or ?token=). No dependencies.
 */
public final class WsServer implements AutoCloseable {
    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int MAX_FRAME = 1 << 20;

    private final ServerSocket server;
    private final byte[] token;
    private final Consumer<String> onMessage;
    private final Runnable onClientChange;
    private final AtomicReference<Conn> active = new AtomicReference<>();
    private volatile boolean closed;

    public WsServer(String token, Consumer<String> onMessage, Runnable onClientChange) throws IOException {
        this.token = token.getBytes(StandardCharsets.UTF_8);
        this.onMessage = onMessage;
        this.onClientChange = onClientChange;
        this.server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
        Thread t = new Thread(this::acceptLoop, "autism-mcp-ws-accept");
        t.setDaemon(true);
        t.start();
    }

    public int port() {
        return server.getLocalPort();
    }

    public boolean hasClient() {
        return active.get() != null;
    }

    public void send(String text) {
        Conn c = active.get();
        if (c != null) c.sendText(text);
    }

    private void acceptLoop() {
        while (!closed) {
            Socket s;
            try {
                s = server.accept();
            } catch (IOException e) {
                return;
            }
            Thread t = new Thread(() -> handle(s), "autism-mcp-ws-conn");
            t.setDaemon(true);
            t.start();
        }
    }

    private void handle(Socket s) {
        try {
            s.setSoTimeout(5000);
            if (!s.getInetAddress().isLoopbackAddress()) {
                s.close();
                return;
            }
            DataInputStream in = new DataInputStream(new BufferedInputStream(s.getInputStream()));
            OutputStream out = s.getOutputStream();
            String head = readHead(in);
            String key = null;
            String presented = null;
            String[] lines = head.split("\r\n");
            if (lines.length > 0 && lines[0].contains("token=")) {
                String l = lines[0];
                int i = l.indexOf("token=") + 6;
                int e = l.indexOf(' ', i);
                presented = l.substring(i, e < 0 ? l.length() : e);
            }
            for (String l : lines) {
                int c = l.indexOf(':');
                if (c < 0) continue;
                String name = l.substring(0, c).trim().toLowerCase();
                String val = l.substring(c + 1).trim();
                if (name.equals("sec-websocket-key")) key = val;
                if (name.equals("x-autism-token")) presented = val;
            }
            if (key == null || presented == null
                || !MessageDigest.isEqual(presented.getBytes(StandardCharsets.UTF_8), token)) {
                out.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                out.flush();
                s.close();
                return;
            }
            Conn conn = new Conn(s, in, out);
            if (!active.compareAndSet(null, conn)) {
                out.write("HTTP/1.1 503 Busy\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                out.flush();
                s.close();
                return;
            }
            String accept = Base64.getEncoder().encodeToString(
                MessageDigest.getInstance("SHA-1").digest((key + GUID).getBytes(StandardCharsets.US_ASCII)));
            out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            out.flush();
            s.setSoTimeout(0);
            onClientChange.run();
            try {
                conn.readLoop();
            } finally {
                active.compareAndSet(conn, null);
                try { s.close(); } catch (IOException ignored) { }
                onClientChange.run();
            }
        } catch (Exception e) {
            try { s.close(); } catch (IOException ignored) { }
        }
    }

    private static String readHead(DataInputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int state = 0;
        while (buf.size() < 8192) {
            int b = in.read();
            if (b < 0) throw new EOFException();
            buf.write(b);
            state = (b == '\r' && (state == 0 || state == 2)) ? state + 1 : (b == '\n' && (state == 1 || state == 3)) ? state + 1 : 0;
            if (state == 4) return buf.toString(StandardCharsets.ISO_8859_1);
        }
        throw new IOException("header too large");
    }

    @Override
    public void close() {
        closed = true;
        try { server.close(); } catch (IOException ignored) { }
        Conn c = active.getAndSet(null);
        if (c != null) {
            try { c.socket.close(); } catch (IOException ignored) { }
        }
    }

    private final class Conn {
        final Socket socket;
        final DataInputStream in;
        final OutputStream out;

        Conn(Socket socket, DataInputStream in, OutputStream out) {
            this.socket = socket;
            this.in = in;
            this.out = out;
        }

        void readLoop() throws IOException {
            ByteArrayOutputStream message = new ByteArrayOutputStream();
            while (!closed) {
                int b0 = in.read();
                if (b0 < 0) return;
                int b1 = in.readUnsignedByte();
                boolean fin = (b0 & 0x80) != 0;
                int op = b0 & 0x0F;
                boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7F;
                if (len == 126) len = in.readUnsignedShort();
                else if (len == 127) len = in.readLong();
                if (!masked || len < 0 || len > MAX_FRAME) {
                    sendClose(1009);
                    return;
                }
                byte[] mask = new byte[4];
                in.readFully(mask);
                byte[] data = new byte[(int) len];
                in.readFully(data);
                for (int i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
                switch (op) {
                    case 0x8 -> { sendClose(1000); return; }
                    case 0x9 -> sendFrame(0xA, data);
                    case 0xA -> { }
                    case 0x1, 0x0 -> {
                        message.write(data);
                        if (message.size() > MAX_FRAME) { sendClose(1009); return; }
                        if (fin) {
                            String text = message.toString(StandardCharsets.UTF_8);
                            message.reset();
                            onMessage.accept(text);
                        }
                    }
                    default -> { }
                }
            }
        }

        void sendText(String text) {
            try {
                sendFrame(0x1, text.getBytes(StandardCharsets.UTF_8));
            } catch (IOException e) {
                try { socket.close(); } catch (IOException ignored) { }
            }
        }

        void sendClose(int code) {
            try {
                sendFrame(0x8, new byte[] {(byte) (code >> 8), (byte) code});
            } catch (IOException ignored) { }
        }

        synchronized void sendFrame(int op, byte[] data) throws IOException {
            ByteArrayOutputStream f = new ByteArrayOutputStream(data.length + 10);
            f.write(0x80 | op);
            if (data.length < 126) {
                f.write(data.length);
            } else if (data.length <= 0xFFFF) {
                f.write(126);
                f.write(data.length >> 8);
                f.write(data.length);
            } else {
                f.write(127);
                for (int i = 7; i >= 0; i--) f.write((int) (((long) data.length >> (8 * i)) & 0xFF));
            }
            f.write(data);
            out.write(f.toByteArray());
            out.flush();
        }
    }
}
