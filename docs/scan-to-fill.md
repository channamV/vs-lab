# Scan to fill

Take a photo of a document and let the platform fill in the form for you. A manager always checks the details before
anything is saved.

Where it works today:
- **Training records** (Operators → an operator → Add training record → **Scan certificate**): reads the certification
  name, issue and expiry dates, provider, card number and the holder's name. It picks the matching certification from
  your list, and warns if the name on the card isn't the operator's.
- **Machines** (Add machine, or Edit on a machine page → **Scan serial plate or VIN**): works with either an equipment
  ID plate or a photo of a VIN (dashboard plate through the windshield, door-jamb sticker, registration). It reads the
  number, checks it and decodes a VIN in the same step (see below), and fills make, model, year, serial number, and a
  category and name if those are empty.
  - **ID plate:** what's printed on the plate fills the form; the number check then points out anything that disagrees.
  - **VIN:** the decoded VIN leads (make, model, year, type); anything else readable in the photo fills what's left.

The button opens the phone's camera (or lets you choose a photo or PDF on a computer). Photos are shrunk on the phone
first. Anything the scan can't read clearly is left blank rather than guessed.

## VIN and PIN check (machines)

As part of every scan, and whenever you press **Check VIN / PIN** under the Serial # / VIN field, the number is checked:

- **On-road vehicles (17-character VIN):** the 9th character is a check digit, so most misread characters are caught
  ("one character is probably misread, compare it with the plate"). The VIN is decoded with NHTSA's free public
  database (the US vehicle safety regulator; covers most vehicles sold in Canada): make, model, year and body type.
- **Heavy equipment (17-character PIN):** there's no free public database for these. The first three characters name
  the manufacturer (Caterpillar, Komatsu, Volvo, JCB, Hitachi, John Deere, Case, Develon/Doosan, Hyundai), so the make
  is filled in; the model comes from the plate scan.
- Shorter or older serial numbers can't be looked up; nothing changes.
- **Misread characters (scans only):** VINs never use I, O or Q, so a scan's I/O/Q become 1/0. If the check digit still
  fails and swapping exactly one look-alike character (5/S, 8/B, 2/Z, 6/G, 0/D, U/V) makes it match, the corrected VIN
  is used and the form says so ("the photo read X; corrected to Y, compare it with the plate"). With two misreads the
  "fix" can occasionally be wrong, hence the note. Numbers typed by hand are never changed (`repairVin` in `vin.ts`).

Empty fields are filled in. A field that already has a different value is **not** overwritten: the form lists it
("the form says X, the VIN says Y") so you can decide. Only the number goes to NHTSA; nothing is saved until you
save the machine. A VIN identifies a vehicle, not a person.

## Keeping the photo ("Retain images after processing")

- **Settings → Scanning documents** (owners): on by default. When a certificate is scanned, its photo is attached to the
  training record as the certificate copy.
- Each scan also has **Keep this photo with the record**, so a manager can choose per record.
- Not kept: the photo is only sent to be read, then discarded. Only the details typed into the record are saved.
- Serial plate and VIN photos are never kept. On a registration, people's names and addresses are ignored.

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
- VIN/PIN check: `platform/src/lib/vin.ts` (check digit, manufacturer codes, NHTSA vPIC `DecodeVinValues`; tested in
  `vin.test.ts`), action `lookupSerialAction`, form logic in `src/app/(admin)/machines/SerialLookup.tsx`.
- Reusable button: `platform/src/components/ScanButton.tsx` (shrinks the photo, calls a server action, shows errors).
  To add scanning to another form: a schema + function in `scan.ts`, a manager-only server action, and a `ScanButton`
  whose `onScan` fills the form.
