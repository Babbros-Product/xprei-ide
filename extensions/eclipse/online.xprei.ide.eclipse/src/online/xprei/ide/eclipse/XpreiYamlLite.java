package online.xprei.ide.eclipse;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Hand-rolled restricted-subset YAML parser/serializer, ported by hand
 * from packages/core/src/config/yamlLite.ts — same supported grammar
 * (block mappings, "- " sequences, simple quoted/unquoted scalars, "#"
 * comments), same NOT-supported list (no anchors, no flow collections,
 * no multi-document files). Mirrors this package's own {@link MiniJson}
 * in spirit (hand-rolled, dependency-free), just for YAML instead of
 * JSON. NOT compiled or tested in this environment (no local Maven
 * available) — verify against a real Eclipse workspace before relying
 * on it. See
 * docs/superpowers/specs/2026-07-26-phase6-shared-config-design.md.
 */
public final class XpreiYamlLite {
    private XpreiYamlLite() {}

    private static final Pattern NUMERIC = Pattern.compile("^-?\\d+(\\.\\d+)?$");

    private static final class Line {
        final int indent;
        final String text;
        Line(int indent, String text) { this.indent = indent; this.text = text; }
    }

    private static List<Line> tokenize(String content) {
        List<Line> lines = new ArrayList<>();
        for (String rawLine : content.split("\r?\n", -1)) {
            String line = rawLine;
            boolean inSingle = false, inDouble = false;
            int cut = line.length();
            for (int i = 0; i < line.length(); i++) {
                char ch = line.charAt(i);
                if (ch == '\'' && !inDouble) inSingle = !inSingle;
                else if (ch == '"' && !inSingle) inDouble = !inDouble;
                else if (ch == '#' && !inSingle && !inDouble) { cut = i; break; }
            }
            line = line.substring(0, cut).replaceAll("\\s+$", "");
            if (line.trim().isEmpty()) continue;
            int indent = line.length() - stripLeading(line).length();
            lines.add(new Line(indent, line.trim()));
        }
        return lines;
    }

    private static String stripLeading(String s) {
        int i = 0;
        while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        return s.substring(i);
    }

    private static int findKeyColon(String text) {
        boolean inSingle = false, inDouble = false;
        for (int k = 0; k < text.length(); k++) {
            char ch = text.charAt(k);
            if (ch == '\'' && !inDouble) inSingle = !inSingle;
            else if (ch == '"' && !inSingle) inDouble = !inDouble;
            else if (ch == ':' && !inSingle && !inDouble) {
                if (k == text.length() - 1 || text.charAt(k + 1) == ' ') return k;
            }
        }
        return -1;
    }

    private static String stripQuotes(String s) {
        if (s.length() >= 2) {
            char first = s.charAt(0), last = s.charAt(s.length() - 1);
            if ((first == '"' && last == '"') || (first == '\'' && last == '\'')) {
                return s.substring(1, s.length() - 1);
            }
        }
        return s;
    }

    private static Object parseScalar(String raw) {
        String s = raw.trim();
        if (s.isEmpty() || s.equals("~") || s.equals("null")) return null;
        if (s.equals("true")) return Boolean.TRUE;
        if (s.equals("false")) return Boolean.FALSE;
        if (NUMERIC.matcher(s).matches()) return Double.parseDouble(s);
        return stripQuotes(s);
    }

    /** Result of a parseBlock() call: the parsed value plus the next unconsumed line index. */
    private static final class Result {
        final Object value;
        final int next;
        Result(Object value, int next) { this.value = value; this.next = next; }
    }

    /** Returns Map&lt;String,Object&gt; where Object is String/Double/Boolean/null/List/Map. */
    public static Map<String, Object> parse(String content) {
        List<Line> lines = tokenize(content);
        if (lines.isEmpty()) return new LinkedHashMap<>();
        @SuppressWarnings("unchecked")
        Map<String, Object> out = (Map<String, Object>) parseMapping(lines, 0, lines.get(0).indent).value;
        return out;
    }

    private static Result parseBlock(List<Line> lines, int start) {
        int indent = lines.get(start).indent;
        String text = lines.get(start).text;
        if (text.startsWith("- ") || text.equals("-")) {
            return parseSequence(lines, start, indent);
        }
        return parseMapping(lines, start, indent);
    }

    private static Result parseSequence(List<Line> lines, int start, int indent) {
        List<Object> out = new ArrayList<>();
        int i = start;
        while (i < lines.size() && lines.get(i).indent == indent &&
                (lines.get(i).text.startsWith("- ") || lines.get(i).text.equals("-"))) {
            String itemText = lines.get(i).text.equals("-") ? "" : lines.get(i).text.substring(2);
            int childIndent = indent + 2;
            if (itemText.isEmpty()) {
                if (i + 1 < lines.size() && lines.get(i + 1).indent > indent) {
                    Result child = parseBlock(lines, i + 1);
                    out.add(child.value);
                    i = child.next;
                } else {
                    out.add(null);
                    i++;
                }
                continue;
            }
            int colonIdx = findKeyColon(itemText);
            if (colonIdx == -1) {
                out.add(parseScalar(itemText));
                i++;
                continue;
            }
            List<Line> synthetic = new ArrayList<>();
            synthetic.add(new Line(childIndent, itemText));
            int j = i + 1;
            while (j < lines.size() && lines.get(j).indent >= childIndent) {
                synthetic.add(lines.get(j));
                j++;
            }
            Result mapResult = parseMapping(synthetic, 0, childIndent);
            out.add(mapResult.value);
            i = j;
        }
        return new Result(out, i);
    }

    private static Result parseMapping(List<Line> lines, int start, int indent) {
        Map<String, Object> out = new LinkedHashMap<>();
        int i = start;
        while (i < lines.size() && lines.get(i).indent == indent) {
            String text = lines.get(i).text;
            int colonIdx = findKeyColon(text);
            if (colonIdx == -1) break;
            String key = stripQuotes(text.substring(0, colonIdx).trim());
            String rest = text.substring(colonIdx + 1).trim();
            if (rest.isEmpty()) {
                if (i + 1 < lines.size() && lines.get(i + 1).indent > indent) {
                    Result child = parseBlock(lines, i + 1);
                    out.put(key, child.value);
                    i = child.next;
                } else {
                    out.put(key, null);
                    i++;
                }
            } else {
                out.put(key, parseScalar(rest));
                i++;
            }
        }
        return new Result(out, i);
    }

    private static boolean needsQuoting(String s) {
        if (s.isEmpty()) return true;
        if (NUMERIC.matcher(s).matches()) return true;
        if (s.equals("true") || s.equals("false") || s.equals("null") || s.equals("~")) return true;
        if (Character.isWhitespace(s.charAt(0)) || Character.isWhitespace(s.charAt(s.length() - 1))) return true;
        if (s.contains(": ") || s.startsWith("#") || s.startsWith("- ") ||
                s.startsWith("'") || s.startsWith("\"")) return true;
        return false;
    }

    private static String quoteScalar(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private static String formatScalar(Object v) {
        if (v == null) return "null";
        if (v instanceof Boolean) return v.toString();
        if (v instanceof Double) {
            double d = (Double) v;
            return d == Math.floor(d) && !Double.isInfinite(d) ? Long.toString((long) d) : Double.toString(d);
        }
        String s = v.toString();
        return needsQuoting(s) ? quoteScalar(s) : s;
    }

    public static String stringify(Map<String, Object> value) {
        List<String> lines = new ArrayList<>();
        stringifyValue(value, 0, lines);
        StringBuilder sb = new StringBuilder();
        for (String line : lines) sb.append(line).append("\n");
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private static void stringifyValue(Object value, int indent, List<String> lines) {
        String pad = repeat(" ", indent);
        if (value instanceof List) {
            for (Object item : (List<Object>) value) {
                if (item instanceof Map) {
                    Map<String, Object> m = (Map<String, Object>) item;
                    List<Map.Entry<String, Object>> entries = new ArrayList<>(m.entrySet());
                    if (entries.isEmpty()) { lines.add(pad + "- {}"); continue; }
                    Map.Entry<String, Object> first = entries.get(0);
                    if (first.getValue() instanceof Map || first.getValue() instanceof List) {
                        lines.add(pad + "- " + first.getKey() + ":");
                        stringifyValue(first.getValue(), indent + 4, lines);
                    } else {
                        lines.add(pad + "- " + first.getKey() + ": " + formatScalar(first.getValue()));
                    }
                    for (Map.Entry<String, Object> e : entries.subList(1, entries.size())) {
                        if (e.getValue() instanceof Map || e.getValue() instanceof List) {
                            lines.add(pad + "  " + e.getKey() + ":");
                            stringifyValue(e.getValue(), indent + 4, lines);
                        } else {
                            lines.add(pad + "  " + e.getKey() + ": " + formatScalar(e.getValue()));
                        }
                    }
                } else if (item instanceof List) {
                    lines.add(pad + "-");
                    stringifyValue(item, indent + 2, lines);
                } else {
                    lines.add(pad + "- " + formatScalar(item));
                }
            }
            return;
        }
        if (value instanceof Map) {
            for (Map.Entry<String, Object> e : ((Map<String, Object>) value).entrySet()) {
                if (e.getValue() instanceof Map || e.getValue() instanceof List) {
                    lines.add(pad + e.getKey() + ":");
                    stringifyValue(e.getValue(), indent + 2, lines);
                } else {
                    lines.add(pad + e.getKey() + ": " + formatScalar(e.getValue()));
                }
            }
        }
    }

    private static String repeat(String s, int n) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) sb.append(s);
        return sb.toString();
    }
}
