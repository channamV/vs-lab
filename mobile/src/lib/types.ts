/** Shapes of the vs-lab app API (platform/src/app/api/app, docs/operator-app.md). */

export type Account = { token: string; operatorId: number; operatorName: string; organizationName: string };

export type Machine = {
  id: number;
  code: string;
  label: string;
  tier: "gps" | "monitor" | "control";
  mode: "access_controlled" | "unlocked" | "locked";
  lockedOut: boolean;
  trainingMissing: string[];
  checklist: { frequency: string; doneTodayAt: string | null };
  currentOperator: { name: string; isMe: boolean } | null;
  openIssues: number;
  relay: { deviceId: string; bluetoothName: string } | null;
};

export type Me = { operator: { id: number; name: string }; organization: { name: string }; machines: Machine[] };

export type Severity = "pass" | "minor" | "major" | "na";
export type AnswerOption = { key: string; label: string; severity: Severity; color: string };
export type Question = {
  id: string;
  text: string;
  noteRequired: boolean;
  photoRequired?: boolean;
  photoOnly?: boolean;
  textOnly?: boolean;
  prefill?: "place";
};
export type Section = { id: string; title: string; questions: Question[] };

export type Checklist = {
  machine: { id: number; code: string; label: string; onRoad: boolean };
  checklist: {
    name: string;
    sections: Section[];
    options: AnswerOption[];
    confirmationText: string;
    frequency: string;
    doneTodayAt: string | null;
    photosEnabled: boolean;
    meter: { kind: "hours" | "km"; value: number | null; hint: number | null };
    placeQuestionIds: string[];
    place: string | null;
  };
};

export type Unlock = { deviceId: string; bluetoothName: string; pass: string };

export type CheckinResult =
  | {
      ok: true;
      checkinId: number;
      operatorName: string;
      authorized: boolean;
      failedItems: string[];
      lockedOut: boolean;
      engineRunning: boolean;
      relay: "wait" | "blocked" | null;
      startWindowMinutes: number;
      unlock: Unlock | null;
    }
  | { ok: false; reason: string; message: string };

export type OfflinePass = { machineCode: string; deviceId: string; bluetoothName: string; pass: string; validUntil: string };
