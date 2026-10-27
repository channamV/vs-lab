import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { Badge, Button, Card, Field, Notice, colors, s } from "@/components/ui";
import { api, ApiError, OfflineError } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { unlockMachine } from "@/lib/ble";
import { canSkip, emptyForm, formFields, hasMajor, lockingOut, missing, photoFields, severityOf, type FormState } from "@/lib/checklist-form";
import { phonePosition, takePhoto } from "@/lib/device";
import { offline } from "@/lib/offline";
import type { Checklist, CheckinResult } from "@/lib/types";

const MAX_PHOTOS = 3;

type Done =
  | { kind: "sent"; result: Extract<CheckinResult, { ok: true }> }
  | { kind: "queued"; relay: boolean }
  | { kind: "locked-out"; items: string[] };

/**
 * The machine's pre-start checklist, then check-in (the same rules as the QR page). With signal it's sent at once;
 * without, it's kept and sent later, and a Safety & Access Control machine is unlocked with the offline pass.
 */
export default function ChecklistScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { account, me, refresh } = useApp();
  const op = account!.operatorId;
  const machine = me?.machines.find((m) => m.code === code) ?? null;
  const [data, setData] = useState<Checklist | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const edited = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [unlock, setUnlock] = useState<{ busy: boolean; ok?: boolean; message?: string }>({ busy: false });

  useEffect(() => {
    (async () => {
      let c: Checklist | null = null;
      try {
        c = await api.checklist(account!.token, code);
        await offline.saveChecklist(op, code, c);
      } catch (e) {
        if (!(e instanceof OfflineError)) return setLoadError(e instanceof ApiError ? e.message : "Couldn't load the checklist.");
        c = await offline.checklist(op, code);
        if (!c) return setLoadError("No signal, and this machine's checklist isn't saved on the phone yet. Open the app once with signal.");
      }
      setData(c);
      setForm(emptyForm(c.checklist, c.checklist.place));
      // Town questions: from the phone's position when it's known (unless the operator has typed something).
      if (c.checklist.placeQuestionIds.length) {
        const pos = await phonePosition();
        if (!pos) return;
        const place = await api.place(account!.token, pos.lat, pos.lng).then((r) => r.place).catch(() => null);
        if (!place) return;
        setForm((f) => f && { ...f, notes: { ...f.notes, ...Object.fromEntries(c!.checklist.placeQuestionIds.filter((id) => !edited.current.has(id)).map((id) => [id, place])) } });
      }
    })();
  }, [account, code, op]);

  if (loadError) return <View style={[s.screen, s.content]}><Notice tone="danger" text={loadError} /></View>;
  if (!data || !form) return <View style={[s.screen, s.content]}><Text style={s.muted}>Loading the checklist…</Text></View>;
  const c = data.checklist;
  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch });
  const todo = missing(c, form);

  async function doUnlock(bluetoothName: string, pass: string) {
    setUnlock({ busy: true });
    const r = await unlockMachine(bluetoothName, pass);
    setUnlock({ busy: false, ok: r.ok, message: r.message });
  }

  async function submit() {
    setError(null);
    if (todo.length) return setError(`Still to do: ${todo.slice(0, 4).join("; ")}${todo.length > 4 ? "…" : ""}`);
    setBusy(true);
    const phone = await phonePosition();
    const fields = formFields(c, form!, phone);
    const photos = photoFields(form!);
    const completedAt = new Date().toISOString();
    try {
      const body = new FormData();
      for (const [k, v] of fields) body.append(k, v);
      for (const p of photos) body.append(p.field, { uri: p.uri, name: p.name, type: p.type } as unknown as Blob);
      const result = await api.checkIn(account!.token, code, body);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (result.lockedOut) setDone({ kind: "locked-out", items: result.failedItems });
      else {
        setDone({ kind: "sent", result });
        if (result.unlock) doUnlock(result.unlock.bluetoothName, result.unlock.pass);
      }
      refresh().catch(() => {});
    } catch (e) {
      if (!(e instanceof OfflineError)) {
        setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
        return;
      }
      // No signal: keep it, and unlock with the offline pass on a relay machine.
      await offline.enqueue(op, { id: `${Date.now()}`, machineCode: code, machineLabel: data!.machine.label, fields, photos, completedAt });
      const lockingOutNow = lockingOut(c, form!);
      setDone(lockingOutNow ? { kind: "locked-out", items: [] } : { kind: "queued", relay: Boolean(machine?.relay) });
      if (!lockingOutNow && machine?.relay) {
        const pass = await offline.pass(op, code);
        if (pass) doUnlock(pass.bluetoothName, pass.pass);
        else setUnlock({ busy: false, ok: false, message: "No unlock pass saved for this machine. Open the app with signal first." });
      }
      refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  if (done) return <Result done={done} unlock={unlock} onBack={() => router.back()} />;

  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Text style={s.h1}>{data.machine.label}</Text>
        <Text style={s.muted}>{c.name}</Text>

        {canSkip(c) && (
          <Card style={{ backgroundColor: "#E0F2FE", borderColor: "#BAE6FD" }}>
            {form.skip ? (
              <>
                <Text style={s.body}>
                  {c.doneTodayAt ? `Today's checklist was done at ${c.doneTodayAt}. You don't need to do it again today.` : "Checking in without the checklist: you did it on this machine earlier today."}
                </Text>
                <Button title="Do the checklist anyway" kind="secondary" onPress={() => set({ skip: false })} />
              </>
            ) : (
              <>
                <Text style={s.body}>{c.frequency === "machine_daily" ? "Needed once a day per machine." : "Needed once a day per operator on each machine."} Already done today?</Text>
                <Button title="Check in without the checklist" kind="secondary" onPress={() => set({ skip: true })} />
              </>
            )}
          </Card>
        )}

        {!form.skip && (
          <>
            <Card>
              <Field
                label={c.meter.kind === "km" ? "Odometer reading (km)" : "Hour meter reading (hours)"}
                value={form.meter}
                onChangeText={(t) => set({ meter: t })}
                keyboardType="decimal-pad"
              />
              <Text style={s.muted}>
                {c.meter.value !== null
                  ? "Filled in from the engine computer. Change it if the meter shows something different."
                  : c.meter.hint !== null
                    ? `Last known: about ${c.meter.hint.toLocaleString()} ${c.meter.kind === "km" ? "km" : "h"}.`
                    : "As shown on the machine's meter."}
              </Text>
            </Card>
            {c.sections.map((section) => (
              <View key={section.id} style={{ gap: 10 }}>
                <Text style={[s.muted, { fontWeight: "700", textTransform: "uppercase", marginTop: 8 }]}>{section.title}</Text>
                {section.questions.map((q) => {
                  const sev = severityOf(c, form.answers[q.id]);
                  const defect = sev === "minor" || sev === "major";
                  const photos = form.photos[q.id] ?? [];
                  return (
                    <Card key={q.id}>
                      <Text style={s.body}>{q.text}</Text>
                      {q.textOnly ? (
                        <Field
                          value={form.notes[q.id] ?? ""}
                          onChangeText={(t) => {
                            edited.current.add(q.id);
                            set({ notes: { ...form.notes, [q.id]: t } });
                          }}
                        />
                      ) : !q.photoOnly ? (
                        <View style={[s.row, { gap: 8 }]}>
                          {c.options.map((o) => {
                            const chosen = form.answers[q.id] === o.key;
                            return (
                              <Pressable
                                key={o.key}
                                onPress={() => set({ answers: { ...form.answers, [q.id]: o.key } })}
                                style={{
                                  flexBasis: "47%",
                                  flexGrow: 1,
                                  minHeight: 48,
                                  borderRadius: 10,
                                  borderWidth: 2,
                                  borderColor: chosen ? o.color : colors.border,
                                  backgroundColor: chosen ? `${o.color}22` : "#fff",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  padding: 6,
                                }}
                              >
                                <Text style={{ fontSize: 16, fontWeight: chosen ? "700" : "500", color: chosen ? o.color : colors.text, textAlign: "center" }}>{o.label}</Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      ) : null}
                      {defect && !q.textOnly && (
                        <Field
                          placeholder={q.noteRequired ? "Describe the problem (required)" : "Describe the problem (optional)"}
                          value={form.notes[q.id] ?? ""}
                          onChangeText={(t) => set({ notes: { ...form.notes, [q.id]: t } })}
                        />
                      )}
                      {c.photosEnabled && (
                        <View style={s.row}>
                          {photos.map((p, i) => (
                            <Pressable key={p.uri} onPress={() => set({ photos: { ...form.photos, [q.id]: photos.filter((_, n) => n !== i) } })}>
                              <Image source={{ uri: p.uri }} style={{ width: 64, height: 64, borderRadius: 8 }} />
                            </Pressable>
                          ))}
                          {photos.length < MAX_PHOTOS && (
                            <Button
                              title={photos.length ? "📷 Another" : q.photoRequired || q.photoOnly ? "📷 Take photo (required)" : "📷 Add photo"}
                              kind="secondary"
                              onPress={async () => {
                                const p = await takePhoto();
                                if (p) setForm((f) => f && { ...f, photos: { ...f.photos, [q.id]: [...(f.photos[q.id] ?? []), p] } });
                              }}
                            />
                          )}
                        </View>
                      )}
                    </Card>
                  );
                })}
              </View>
            ))}
          </>
        )}

        <Field label="Notes (optional)" value={form.generalNotes} onChangeText={(t) => set({ generalNotes: t })} multiline placeholder="Anything else your supervisor should know" />

        {!form.skip && hasMajor(c, form) && (
          <Card style={{ borderColor: "#FCA5A5", backgroundColor: colors.dangerBg }}>
            <Text style={[s.body, { color: colors.danger, fontWeight: "600" }]}>You reported a major defect. Lock out this machine for repair?</Text>
            <Button title="Yes, lock it out" kind={form.lockout === "yes" ? "danger" : "secondary"} onPress={() => set({ lockout: "yes" })} />
            <Button title="No, it's safe to operate" kind={form.lockout === "no" ? "primary" : "secondary"} onPress={() => set({ lockout: "no" })} />
          </Card>
        )}

        {!form.skip && !lockingOut(c, form) && (
          <Card>
            <View style={[s.row, { flexWrap: "nowrap" }]}>
              <Switch value={form.confirmed} onValueChange={(v) => set({ confirmed: v })} />
              <Text style={[s.body, { flex: 1, fontWeight: "600" }]}>{c.confirmationText}</Text>
            </View>
          </Card>
        )}

        {error && <Notice tone="danger" text={error} />}
        <Button title={lockingOut(c, form) ? "Lock out machine" : "Check in"} kind={lockingOut(c, form) ? "danger" : "primary"} onPress={submit} busy={busy} />
        <Text style={[s.muted, { textAlign: "center" }]}>Your location is used to confirm you&apos;re at the machine.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Result({ done, unlock, onBack }: { done: Done; unlock: { busy: boolean; ok?: boolean; message?: string }; onBack: () => void }) {
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      {done.kind === "locked-out" ? (
        <Notice tone="danger" text={`🔒 Machine locked out for repair. Do not operate it. Your supervisor has been told${done.items.length ? `: ${done.items.join("; ")}` : ""}.`} />
      ) : done.kind === "queued" ? (
        <Notice tone="warn" text="No signal: your check-in is saved on the phone and will be sent as soon as there's signal." />
      ) : (
        <>
          <Notice tone="ok" text={`✓ Checked in: ${done.result.operatorName}`} />
          {!done.result.authorized && <Notice tone="warn" text="You're not on the approved list for this machine. Talk to your supervisor before operating it." />}
          {done.result.relay === "blocked" && <Notice tone="danger" text="This machine won't start for you: you're not approved to operate it." />}
          {done.result.failedItems.length > 0 && <Notice tone="warn" text={`Defects reported (your supervisor has been told): ${done.result.failedItems.join("; ")}`} />}
          <Text style={s.body}>
            {done.result.engineRunning ? "The engine is running: you're now the operator." : `Start the engine within ${done.result.startWindowMinutes} minutes.`} You&apos;ll be checked out automatically when the engine
            stops.
          </Text>
        </>
      )}
      {unlock.busy && <Badge text="🔑 Unlocking the machine over Bluetooth…" />}
      {unlock.message && <Notice tone={unlock.ok ? "ok" : "danger"} text={unlock.message} />}
      <Button title="Done" onPress={onBack} />
    </ScrollView>
  );
}
