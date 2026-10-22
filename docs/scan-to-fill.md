# Scan to fill

Take a photo of a document and let the platform fill in the form for you. A manager always checks the details before
anything is saved.

Where it works today:
- **Training records** (Operators → an operator → Add training record → **Scan certificate**): reads the certification
  name, issue and expiry dates, provider, card number and the holder's name. It picks the matching certification from
  your list, and warns if the name on the card isn't the operator's.
- **Machines** (Add machine, or Edit on a machine page → **Scan serial plate**): reads make, model, year and serial
  number / PIN, and suggests a category and name if those are empty.

The button opens the phone's camera (or lets you choose a photo or PDF on a computer). Photos are shrunk on the phone
first. Anything the scan can't read clearly is left blank rather than guessed.

## Keeping the photo ("Retain images after processing")

- **Settings → Scanning documents** (owners): on by default. When a certificate is scanned, its photo is attached to the
  training record as the certificate copy.
- Each scan also has **Keep this photo with the record**, so a manager can choose per record.
- Not kept: the photo is only sent to be read, then discarded. Only the details typed into the record are saved.
- Serial plate photos are never kept.

## Setting it up

Scanning uses Claude (Anthropic's AI) through its API. It needs one setting in Vercel:

1. Get an API key at console.anthropic.com (Veristart's account) → API keys.
2. Vercel → vs-lab project → Settings → Environment Variables → add `ANTHROPIC_API_KEY` (Production and Preview).
3. Redeploy. The Scan buttons appear once the key is set; without it they're hidden and nothing else changes.

Cost: each scan is one small request, roughly 1–2 cents.

## Privacy

- The photo goes to Anthropic (United States) to be read, as Veristart's service provider. It's listed in the check-in
  privacy notice. Veristart's privacy policy doesn't mention it yet: see item 8 in [privacy-canada.md](privacy-canada.md).
- A kept certificate photo is part of the training record: private, included in the operator's data download, and deleted
  when the record is deleted or the operator is erased ([privacy.md](privacy.md)).

## For developers

- `platform/src/lib/scan.ts` (tested with a fake client in `scan.test.ts`): `scanTrainingCertificate`, `scanSerialPlate`,
  structured output (Zod) on `claude-opus-5-5` at low effort, server-side fallback on a refusal. Dates and years are
  validated after reading.
- Reusable button: `platform/src/components/ScanButton.tsx` (shrinks the photo, calls a server action, shows errors).
  To add scanning to another form: a schema + function in `scan.ts`, a manager-only server action, and a `ScanButton`
  whose `onScan` fills the form.
