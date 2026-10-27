import { Redirect, router } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Badge, Button, Card, Notice, colors, s } from "@/components/ui";
import { useApp } from "@/lib/app-state";
import { resumeMachine, unlockMachine } from "@/lib/ble";
import { HOLD_OVER } from "@/lib/hold-rules";
import { offline } from "@/lib/offline";
import type { Machine } from "@/lib/types";

/** Home: the operator's machines, what state each is in, and what they can do on it. */
export default function Machines() {
  const { ready, account, accounts, me, savedAt, online, pending, refresh, switchTo, signOut } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  if (ready && !account) return <Redirect href="/sign-in" />;

  async function pullToRefresh() {
    setRefreshing(true);
    await refresh().catch(() => {});
    setRefreshing(false);
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pullToRefresh} />}>
      <View>
        <Text style={s.h1}>{me?.operator.name ?? account?.operatorName}</Text>
        <Text style={s.muted}>{me?.organization.name ?? account?.organizationName}</Text>
      </View>
      {!online && (
        <Notice
          tone="warn"
          text={`No signal: showing what was saved${savedAt ? ` ${new Date(savedAt).toLocaleString()}` : ""}. Check-ins are kept and sent when you're back online.`}
        />
      )}
      {pending.length > 0 && <Notice tone="info" text={`${pending.length} check-in${pending.length === 1 ? "" : "s"} waiting to be sent.`} />}
      {!me ? (
        <Text style={s.muted}>Loading your machines…</Text>
      ) : me.machines.length === 0 ? (
        <Card>
          <Text style={s.body}>No machines yet. Ask your supervisor to approve you for the machines you operate.</Text>
        </Card>
      ) : (
        me.machines.map((m) => <MachineCard key={m.id} m={m} operatorId={account!.operatorId} />)
      )}

      <View style={{ height: 12 }} />
      {accounts.length > 1 && (
        <Card>
          <Text style={s.h2}>Company</Text>
          {accounts.map((a) => (
            <Pressable key={a.operatorId} onPress={() => switchTo(a.operatorId)} style={{ paddingVertical: 8 }}>
              <Text style={[s.body, a.operatorId === account?.operatorId && { fontWeight: "700", color: colors.primary }]}>
                {a.operatorId === account?.operatorId ? "● " : "○ "}
                {a.organizationName}
              </Text>
            </Pressable>
          ))}
        </Card>
      )}
      <Button
        title="Sign out"
        kind="secondary"
        onPress={() =>
          Alert.alert("Sign out?", "You'll need a new code from your email to sign in again.", [
            { text: "Cancel", style: "cancel" },
            { text: "Sign out", style: "destructive", onPress: () => signOut().then(() => router.replace("/sign-in")) },
          ])
        }
      />
    </ScrollView>
  );
}

function MachineCard({ m, operatorId }: { m: Machine; operatorId: number }) {
  const { held, addHold, dropHold } = useApp();
  const hold = held.find((h) => h.machineCode === m.code) ?? null;
  const [unlocking, setUnlocking] = useState(false);
  const [unlockMessage, setUnlockMessage] = useState<{ ok: boolean; message: string } | null>(null);
  const blocked = m.mode === "locked" || m.lockedOut || m.trainingMissing.length > 0;
  const mine = m.currentOperator?.isMe;

  async function unlockAgain() {
    setUnlocking(true);
    const pass = await offline.pass(operatorId, m.code);
    setUnlockMessage(pass ? await unlockMachine(pass.bluetoothName, pass.pass) : { ok: false, message: "No pass saved. Check in again." });
    setUnlocking(false);
  }

  /** Back from a break: the phone proves itself to the machine holding the check-in. */
  async function resume() {
    if (!hold) return;
    setUnlocking(true);
    const r = await resumeMachine(hold);
    if (r.answer && HOLD_OVER.includes(r.answer)) await dropHold(hold.session.checkinId);
    else if (r.bleId && r.bleId !== hold.bleId) await addHold({ ...hold, bleId: r.bleId });
    setUnlockMessage(r);
    setUnlocking(false);
  }

  return (
    <Card>
      <Text style={s.h2}>{m.label}</Text>
      <View style={s.row}>
        {m.lockedOut && <Badge tone="danger" text="🔒 Locked out for repair" />}
        {m.mode === "locked" && !m.lockedOut && <Badge tone="danger" text="🔒 Locked" />}
        {m.mode === "unlocked" && <Badge text="Unlocked" />}
        {m.trainingMissing.length > 0 && <Badge tone="warn" text={`Training needed: ${m.trainingMissing.join(", ")}`} />}
        {m.checklist.doneTodayAt && <Badge tone="ok" text={`Checklist done today ${m.checklist.doneTodayAt}`} />}
        {m.currentOperator && <Badge text={mine ? "You're checked in" : `In use: ${m.currentOperator.name}`} />}
        {m.openIssues > 0 && <Badge tone="warn" text={`${m.openIssues} open defect${m.openIssues === 1 ? "" : "s"}`} />}
      </View>
      {unlockMessage && <Notice tone={unlockMessage.ok ? "ok" : "danger"} text={unlockMessage.message} />}
      <Button
        title={mine ? "Check in again" : "Check in"}
        onPress={() => router.push({ pathname: "/machine/[code]/checklist", params: { code: m.code } })}
        disabled={blocked}
      />
      {hold ? (
        <Button title="I'm back: restart after my break" kind="secondary" onPress={resume} busy={unlocking} />
      ) : (
        mine && m.relay && <Button title="Unlock again" kind="secondary" onPress={unlockAgain} busy={unlocking} />
      )}
      <Button title="Report a problem" kind="secondary" onPress={() => router.push({ pathname: "/machine/[code]/problem", params: { code: m.code } })} />
    </Card>
  );
}
