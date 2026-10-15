// SPDX-License-Identifier: GPL-3.0-only
// Part of autism-mcp-bridge, an addon for AUTISM Client (https://github.com/codedsword/autism-mcp). GPL-3.0.
package io.github.codedsword.autismmcp;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Scope enforcement (allowed_targets), token/port files and the packet rate limiter. */
public final class Safety {
    public static final int HARD_CAP_PPS = 100;
    private static final Pattern TARGETS = Pattern.compile("(?m)^\\s*allowed_targets\\s*=\\s*\\[(.*?)\\]", Pattern.DOTALL);
    private static final Pattern QUOTED = Pattern.compile("\"([^\"]+)\"");

    private Safety() {}

    public static List<String> loadAllowedTargets(Path root) {
        List<String> out = new ArrayList<>();
        try {
            String text = Files.readString(root.resolve("config.toml"), StandardCharsets.UTF_8);
            Matcher m = TARGETS.matcher(text);
            if (m.find()) {
                Matcher q = QUOTED.matcher(m.group(1));
                while (q.find()) out.add(q.group(1).toLowerCase(Locale.ROOT));
            }
        } catch (IOException ignored) { }
        if (out.isEmpty()) {
            out.add("127.0.0.1");
            out.add("localhost");
        }
        return out;
    }

    public static String hostOf(String address) {
        String a = address == null ? "" : address.trim().toLowerCase(Locale.ROOT);
        if (a.startsWith("[")) {
            int e = a.indexOf(']');
            return e > 0 ? a.substring(1, e) : a;
        }
        int i = a.lastIndexOf(':');
        if (i > 0 && a.indexOf(':') == i) a = a.substring(0, i);
        return a;
    }

    public static String newToken() {
        byte[] b = new byte[32];
        new SecureRandom().nextBytes(b);
        return HexFormat.of().formatHex(b);
    }

    /** Creates the file with 0600 permissions before any secret is written to it. */
    public static void writePrivate(Path file, String content) throws IOException {
        Files.createDirectories(file.getParent());
        Files.deleteIfExists(file);
        Files.createFile(file, java.nio.file.attribute.PosixFilePermissions.asFileAttribute(
            PosixFilePermissions.fromString("rw-------")));
        Files.writeString(file, content, StandardCharsets.UTF_8);
    }

    /** Token bucket; thread-safe. */
    public static final class Bucket {
        private final double rate;
        private final double burst;
        private double tokens;
        private long last = System.nanoTime();

        public Bucket(double ratePerSec, double burst) {
            this.rate = Math.min(ratePerSec, HARD_CAP_PPS);
            this.burst = burst;
            this.tokens = burst;
        }

        public synchronized boolean take() {
            long now = System.nanoTime();
            tokens = Math.min(burst, tokens + (now - last) / 1e9 * rate);
            last = now;
            if (tokens >= 1) {
                tokens -= 1;
                return true;
            }
            return false;
        }
    }
}
