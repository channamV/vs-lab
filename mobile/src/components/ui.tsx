import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from "react-native";

/** Shared look: big tap targets and plain colours (jobsite phones, gloves, sunlight). */

export const colors = {
  brand: "#0F172A",
  primary: "#0369A1",
  text: "#0F172A",
  muted: "#64748B",
  border: "#CBD5E1",
  bg: "#F8FAFC",
  card: "#FFFFFF",
  danger: "#B91C1C",
  dangerBg: "#FEE2E2",
  warn: "#92400E",
  warnBg: "#FEF3C7",
  ok: "#047857",
  okBg: "#D1FAE5",
};

export function Button({
  title,
  onPress,
  kind = "primary",
  disabled,
  busy,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
}) {
  const bg = kind === "primary" ? colors.primary : kind === "danger" ? colors.danger : colors.card;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        s.button,
        { backgroundColor: bg, borderColor: kind === "secondary" ? colors.border : bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={kind === "secondary" ? colors.text : "#fff"} /> : <Text style={[s.buttonText, { color: kind === "secondary" ? colors.text : "#fff" }]}>{title}</Text>}
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Badge({ text, tone = "muted" }: { text: string; tone?: "muted" | "danger" | "warn" | "ok" }) {
  const t = { muted: ["#E2E8F0", colors.text], danger: [colors.dangerBg, colors.danger], warn: [colors.warnBg, colors.warn], ok: [colors.okBg, colors.ok] }[tone];
  return (
    <View style={[s.badge, { backgroundColor: t[0] }]}>
      <Text style={[s.badgeText, { color: t[1] }]}>{text}</Text>
    </View>
  );
}

export function Notice({ text, tone }: { text: string; tone: "danger" | "warn" | "ok" | "info" }) {
  const t = { danger: [colors.dangerBg, colors.danger], warn: [colors.warnBg, colors.warn], ok: [colors.okBg, colors.ok], info: ["#E0F2FE", "#075985"] }[tone];
  return (
    <View style={[s.notice, { backgroundColor: t[0] }]}>
      <Text style={{ color: t[1], fontSize: 16 }}>{text}</Text>
    </View>
  );
}

export function Field(props: TextInputProps & { label?: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={{ gap: 6 }}>
      {label ? <Text style={s.label}>{label}</Text> : null}
      <TextInput placeholderTextColor={colors.muted} style={[s.input, style]} {...rest} />
    </View>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  h1: { fontSize: 24, fontWeight: "700", color: colors.text },
  h2: { fontSize: 18, fontWeight: "600", color: colors.text },
  muted: { color: colors.muted, fontSize: 15 },
  body: { color: colors.text, fontSize: 16 },
  label: { color: colors.text, fontSize: 16, fontWeight: "500" },
  button: { minHeight: 52, borderRadius: 10, borderWidth: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  buttonText: { fontSize: 17, fontWeight: "600" },
  card: { backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: "#E2E8F0", padding: 14, gap: 10 },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: "flex-start" },
  badgeText: { fontSize: 13, fontWeight: "600" },
  notice: { borderRadius: 10, padding: 12 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 17, backgroundColor: "#fff", color: colors.text },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" },
});
