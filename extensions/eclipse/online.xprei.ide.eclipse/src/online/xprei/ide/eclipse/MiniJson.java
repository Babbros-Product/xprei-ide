package online.xprei.ide.eclipse;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal, self-contained JSON codec. No external OSGi bundle dependency
 * (Gson/org.json aren't guaranteed present in a bare Eclipse Platform target
 * platform without adding an Orbit p2 repository, which is one more
 * unverified moving part on top of an already-unverified Tycho build — this
 * trades that risk for a small, independently-testable utility class
 * instead). Values: {@code Map<String,Object>} for objects,
 * {@code List<Object>} for arrays, {@code String}, {@code Double},
 * {@code Boolean}, or {@code null}.
 */
public final class MiniJson {
    private MiniJson() {}

    public static Map<String, Object> obj(Object... kv) {
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            m.put(String.valueOf(kv[i]), kv[i + 1]);
        }
        return m;
    }

    public static List<Object> arr(Object... items) {
        List<Object> l = new ArrayList<>();
        for (Object o : items) l.add(o);
        return l;
    }

    // ---- Serialization ----

    public static String stringify(Object v) {
        StringBuilder sb = new StringBuilder();
        write(v, sb);
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private static void write(Object v, StringBuilder sb) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String) {
            writeString((String) v, sb);
        } else if (v instanceof Boolean) {
            sb.append(v.toString());
        } else if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            if (d == Math.floor(d) && !Double.isInfinite(d) && Math.abs(d) < 1e15) {
                sb.append((long) d);
            } else {
                sb.append(d);
            }
        } else if (v instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                writeString(e.getKey(), sb);
                sb.append(':');
                write(e.getValue(), sb);
            }
            sb.append('}');
        } else if (v instanceof List) {
            sb.append('[');
            boolean first = true;
            for (Object item : (List<Object>) v) {
                if (!first) sb.append(',');
                first = false;
                write(item, sb);
            }
            sb.append(']');
        } else {
            writeString(v.toString(), sb);
        }
    }

    private static void writeString(String s, StringBuilder sb) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    // ---- Parsing ----

    public static Object parse(String s) {
        Parser p = new Parser(s);
        p.skipWs();
        return p.parseValue();
    }

    private static final class Parser {
        private final String s;
        private int i = 0;

        Parser(String s) {
            this.s = s;
        }

        void skipWs() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }

        char peek() {
            return s.charAt(i);
        }

        Object parseValue() {
            skipWs();
            char c = peek();
            if (c == '{') return parseObject();
            if (c == '[') return parseArray();
            if (c == '"') return parseString();
            if (c == 't') {
                expect("true");
                return Boolean.TRUE;
            }
            if (c == 'f') {
                expect("false");
                return Boolean.FALSE;
            }
            if (c == 'n') {
                expect("null");
                return null;
            }
            return parseNumber();
        }

        void expect(String lit) {
            if (!s.regionMatches(i, lit, 0, lit.length())) {
                throw new IllegalArgumentException("expected '" + lit + "' at " + i);
            }
            i += lit.length();
        }

        Map<String, Object> parseObject() {
            LinkedHashMap<String, Object> m = new LinkedHashMap<>();
            i++; // '{'
            skipWs();
            if (peek() == '}') {
                i++;
                return m;
            }
            while (true) {
                skipWs();
                String key = parseString();
                skipWs();
                if (peek() != ':') throw new IllegalArgumentException("expected ':' at " + i);
                i++;
                Object val = parseValue();
                m.put(key, val);
                skipWs();
                char c = peek();
                if (c == ',') {
                    i++;
                    continue;
                }
                if (c == '}') {
                    i++;
                    break;
                }
                throw new IllegalArgumentException("expected ',' or '}' at " + i);
            }
            return m;
        }

        List<Object> parseArray() {
            List<Object> l = new ArrayList<>();
            i++; // '['
            skipWs();
            if (peek() == ']') {
                i++;
                return l;
            }
            while (true) {
                Object val = parseValue();
                l.add(val);
                skipWs();
                char c = peek();
                if (c == ',') {
                    i++;
                    continue;
                }
                if (c == ']') {
                    i++;
                    break;
                }
                throw new IllegalArgumentException("expected ',' or ']' at " + i);
            }
            return l;
        }

        String parseString() {
            if (peek() != '"') throw new IllegalArgumentException("expected string at " + i);
            i++;
            StringBuilder sb = new StringBuilder();
            while (true) {
                char c = s.charAt(i++);
                if (c == '"') break;
                if (c == '\\') {
                    char esc = s.charAt(i++);
                    switch (esc) {
                        case '"':
                            sb.append('"');
                            break;
                        case '\\':
                            sb.append('\\');
                            break;
                        case '/':
                            sb.append('/');
                            break;
                        case 'n':
                            sb.append('\n');
                            break;
                        case 'r':
                            sb.append('\r');
                            break;
                        case 't':
                            sb.append('\t');
                            break;
                        case 'b':
                            sb.append('\b');
                            break;
                        case 'f':
                            sb.append('\f');
                            break;
                        case 'u':
                            String hex = s.substring(i, i + 4);
                            sb.append((char) Integer.parseInt(hex, 16));
                            i += 4;
                            break;
                        default:
                            throw new IllegalArgumentException("bad escape at " + i);
                    }
                } else {
                    sb.append(c);
                }
            }
            return sb.toString();
        }

        Double parseNumber() {
            int start = i;
            if (peek() == '-') i++;
            while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
            if (i < s.length() && s.charAt(i) == '.') {
                i++;
                while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
            }
            if (i < s.length() && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
                i++;
                if (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) i++;
                while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
            }
            return Double.parseDouble(s.substring(start, i));
        }
    }

    // ---- Typed accessors on parsed values (avoid repetitive casts at call sites) ----

    @SuppressWarnings("unchecked")
    public static Map<String, Object> asObj(Object v) {
        return v instanceof Map ? (Map<String, Object>) v : new LinkedHashMap<>();
    }

    @SuppressWarnings("unchecked")
    public static List<Object> asArr(Object v) {
        return v instanceof List ? (List<Object>) v : new ArrayList<>();
    }

    public static String asStr(Object v, String fallback) {
        return v instanceof String ? (String) v : fallback;
    }

    public static int asInt(Object v, int fallback) {
        return v instanceof Number ? ((Number) v).intValue() : fallback;
    }
}
