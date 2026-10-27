import { router } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text } from "react-native";
import { Button, Field, Notice, s } from "@/components/ui";
import { api, ApiError, OfflineError } from "@/lib/api";
import { phoneName, useApp } from "@/lib/app-state";

/** Email → 6-digit code by email → signed in on this phone (docs/operator-app.md). No passwords. */
export default function SignIn() {
  const { signedIn } = useApp();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "danger" | "info" } | null>(null);

  const explain = (e: unknown) =>
    setMessage({ tone: "danger", text: e instanceof OfflineError ? "No connection. Signing in needs signal (once)." : e instanceof ApiError ? e.message : "Something went wrong. Try again." });

  async function sendCode() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.requestCode(email.trim());
      setStep("code");
      setMessage({ tone: "info", text: res.message });
    } catch (e) {
      explain(e);
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setMessage(null);
    try {
      const { accounts } = await api.verifyCode(email.trim(), code.trim(), phoneName());
      await signedIn(accounts);
      router.replace("/machines");
    } catch (e) {
      explain(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Text style={s.h1}>Sign in</Text>
        <Text style={s.muted}>Use the email on your operator profile. We&apos;ll send you a code; no password needed.</Text>
        {message && <Notice text={message.text} tone={message.tone} />}
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          editable={step === "email"}
          returnKeyType="send"
          onSubmitEditing={sendCode}
        />
        {step === "email" ? (
          <Button title="Send me a code" onPress={sendCode} busy={busy} disabled={!email.includes("@")} />
        ) : (
          <>
            <Field
              label="Code from the email"
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, 6))}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              maxLength={6}
              style={{ fontSize: 28, letterSpacing: 8, textAlign: "center" }}
            />
            <Button title="Sign in" onPress={verify} busy={busy} disabled={code.length !== 6} />
            <Button
              title="Use a different email"
              kind="secondary"
              onPress={() => {
                setStep("email");
                setCode("");
                setMessage(null);
              }}
            />
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
