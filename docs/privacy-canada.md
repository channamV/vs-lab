# Privacy in Canada (PIPEDA, provincial laws) and Veristart's privacy policy

> **Status (2026-10-22): vs-lab is NOT yet compliant with Veristart's own privacy policy (23 Sept 2024) or ready
> for Canadian customers' real data.** The gaps are listed below. Don't put real customer or operator data into
> vs-lab until the "Must fix" items are done. This page is a working checklist, not legal advice: a privacy
> lawyer should approve the policy and contract wording.

## Which laws apply

- **PIPEDA (federal)** covers Veristart's commercial activity, and customers in provinces without their own law.
- **Customers' employees (operators):** most construction contractors are provincially regulated, so their
  employees' information falls under:
  - Alberta's and BC's PIPA;
  - Quebec's Law 25 (the strictest);
  - PIPEDA, only for federally regulated employers.
- **In practice:** meet PIPEDA plus Quebec's Law 25, and the others are covered too.
- **Roles:**
  - The **customer (employer) is accountable** for its operators' information.
  - **Veristart processes it on the customer's behalf**, which needs a contract saying so (a data processing
    agreement).
  - For portal users and Veristart's own business, Veristart is accountable itself.

## What Veristart's privacy policy (2024-09-23) already covers

- **Privacy Officer:** Privacy@veristart.ca. This covers accountability and the complaints contact.
- **A public policy:** what's collected and why, including equipment use, operation history, and location with
  time and speed.
- **Rights:** access, correction and deletion through the Privacy Officer (deletion within 30–90 days), and
  withdrawing consent.
- **Service providers:** they're bound by contract to the same standards.

## Where vs-lab doesn't match the policy (yet)

| # | Policy says | vs-lab today | Fix |
|---|---|---|---|
| 1 | Data stored "at a private server location hosted by AWS in Canada" | Vercel, Neon and Resend, outside Canada | **Must fix:** move vs-lab to Canadian hosting, or change the policy to list the actual providers and countries |
| 2 | Written as if Veristart collects from everyone directly | Operators' data is collected for their employer (our customer) | **Must fix:** policy explains the customer/Veristart roles; data processing agreement with each customer |
| 3 | Doesn't describe safety monitoring of operators | Speeding, idling, hours/fatigue, restricted areas and checklist photos are linked to named operators | **Must fix:** add these uses to the policy (the check-in notice now mentions them) |
| 4 | "By using the Solution you consent" (bundled consent) | — | **Must fix for Quebec:** consent that's specific and separate; a privacy impact assessment before data leaves Quebec; publish the Privacy Officer's title |
| 5 | Doesn't intend to collect EU (or California) data; will destroy it | vs-lab has GDPR features for future EU customers | Decide: if EU customers are planned, rewrite this section (and see [privacy.md](privacy.md)) |
| 6 | Mentions "residential tenancies or human rights" authorities | — | Remove: left over from a template for another industry |
| 7 | (no breach section; not required in the policy) | **Breach register built** (Platform → Privacy breach register) | **Must do:** write a short internal breach procedure (who decides, who reports, timelines) |

## Technical items (vs-lab)

| Item | Status |
|---|---|
| Retention limits and nightly clean-up | Done ([privacy.md](privacy.md)) |
| Operator data download and erasure | Done |
| Access log (staff opening a customer's data) | Done |
| Operator privacy notice on the check-in page, incl. safety monitoring + link to Veristart's policy and Privacy Officer | Done (2026-10-22) |
| Breach register (every breach, kept 24+ months, never auto-deleted; to-do list per record) | Done (2026-10-22) |
| Remove the shared `ADMIN_PASSWORD` fallback | **To do** before outside users |
| Set `DEVICE_KEY_SECRET` (signed device commands and firmware downloads) | **To do** before real devices run our firmware |
| Canadian hosting (Vercel `yul1` Montréal, Neon/Blob/Resend equivalents) | **To do** (item 1) |
| Link to the exact privacy policy page | The notice links to veristart.ca; replace with the policy's own address when it's online |

## Breach register: how to use it

**Platform → Privacy breach register** (Veristart staff only).

1. **Record every breach** of security safeguards involving personal information, however small. Examples: an
   email to the wrong customer, a lost phone signed into the portal, a misconfigured permission.
2. **Assess the risk.** Is there a "real risk of significant harm"? Weigh how sensitive the information is and how
   likely it is to be misused.
3. **If yes:**
   - report to the **Privacy Commissioner of Canada** (online form) as soon as feasible;
   - notify the people affected;
   - tell the customers whose data it was.
   - Quebec: also report to the Commission d'accès à l'information.
4. **Record what was done.** A record can only be closed once the risk is assessed and, if needed, the report
   and notifications are recorded.
5. **Keep records at least 24 months.** The retention clean-up never deletes them.

## Documents to take to a privacy lawyer

1. Updated privacy policy (items 1–6 above).
2. Data processing agreement for customers (Veristart as service provider for operator data).
3. Internal breach procedure (one page).
4. Quebec privacy impact assessment (for data hosted outside Quebec).
5. Operator notice wording (the check-in page text), for customers to use with their crews.
