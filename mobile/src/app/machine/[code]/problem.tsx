import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { Button, Field, Notice, s } from "@/components/ui";
import { api, ApiError, OfflineError } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import type { PhotoRef } from "@/lib/checklist-form";
import { takePhoto } from "@/lib/device";

/** An operator reports a problem outside the checklist → a maintenance item for the mechanics. */
export default function Problem() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { account, me } = useApp();
  const machine = me?.machines.find((m) => m.code === code);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [photos, setPhotos] = useState<PhotoRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "danger" | "ok" } | null>(null);

  async function send() {
    setBusy(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("title", title.trim());
      form.append("description", description.trim());
      for (const p of photos) form.append("photo", { uri: p.uri, name: p.name, type: p.type } as unknown as Blob);
      const r = await api.reportProblem(account!.token, code, form);
      setMessage({ tone: "ok", text: `Sent as maintenance item #${r.number}. Thanks!` });
      setTitle("");
      setDescription("");
      setPhotos([]);
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof OfflineError ? "No signal. Try again when you have signal." : e instanceof ApiError ? e.message : "Couldn't send it. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>{machine?.label ?? code}</Text>
      <Field label="What's wrong?" value={title} onChangeText={setTitle} placeholder="e.g. Hydraulic leak at the boom" maxLength={200} />
      <Field label="Details (optional)" value={description} onChangeText={setDescription} multiline style={{ minHeight: 100, textAlignVertical: "top" }} />
      <View style={s.row}>
        {photos.map((p, i) => (
          <Pressable key={p.uri} onPress={() => setPhotos(photos.filter((_, n) => n !== i))}>
            <Image source={{ uri: p.uri }} style={{ width: 72, height: 72, borderRadius: 8 }} />
          </Pressable>
        ))}
        {photos.length < 3 && (
          <Button
            title="📷 Add photo"
            kind="secondary"
            onPress={async () => {
              const p = await takePhoto();
              if (p) setPhotos((list) => [...list, p]);
            }}
          />
        )}
      </View>
      {message && <Notice tone={message.tone} text={message.text} />}
      <Button title="Send" onPress={send} busy={busy} disabled={!title.trim()} />
      <Button title="Back" kind="secondary" onPress={() => router.back()} />
    </ScrollView>
  );
}
