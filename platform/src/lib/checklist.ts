/**
 * The pre-start checklist operators complete when they check in.
 * Each item is answered OK / Not OK. A "Not OK" answer is recorded and flagged, but doesn't block
 * the check-in: on Safety & Access Monitoring the machine always starts and the platform reports.
 *
 * To change the questions, edit this list. Answers are stored with the question text, so past
 * check-ins keep showing what was asked at the time. Keep ids stable when rewording.
 */
export const CHECKLIST = [
  { id: "walkaround", question: "Walk-around done: no visible damage" },
  { id: "leaks", question: "No fluid leaks under or around the machine" },
  { id: "fluids", question: "Engine oil, coolant and hydraulic oil levels OK" },
  { id: "undercarriage", question: "Tracks / tires and undercarriage OK" },
  { id: "attachments", question: "Bucket / attachment, pins and couplers secure" },
  { id: "lights", question: "Lights, horn and backup alarm working" },
  { id: "seatbelt", question: "Seatbelt in good condition and working" },
  { id: "extinguisher", question: "Fire extinguisher present and charged" },
  { id: "visibility", question: "Mirrors, windows and camera clean and undamaged" },
  { id: "controls", question: "Controls and safety lockout lever working" },
] as const;
