# Organizations, users and sign-in

VS Lab is multi-tenant: each customer is an **organization** (like a CID). Everything a customer sees
belongs to their organization: machines, operators, check-ins, alerts and users. Nothing is shared
between organizations.

## Signing in

People sign in with their **email address**. They get a one-time link by email, click it, then press
**Sign in to VS Lab**. No passwords.
- The link works once, for 15 minutes.
- A browser stays signed in for 30 days. **Sign out** is in the top bar.
- Turning someone's access off (Users page → untick *Active*) signs them out everywhere.

**Transition:** until email sign-in has been confirmed working, the old admin password still works
under *Use the admin password instead* on the sign-in page. It signs in as the platform admin. Once
you're happy with email links, delete `ADMIN_PASSWORD` in Vercel and that option disappears.

## Roles

| Role | Can |
|---|---|
| **Owner** | Everything, including adding users and changing roles. Gets alert emails. |
| **Manager** | Machines, operators, arm/disarm, acknowledging alerts. Gets alert emails. |
| **Viewer** | Look at everything, change nothing. |

Every organization keeps at least one active owner. Each email address belongs to one organization.

## Platform admins (Veristart staff)

The email addresses in the Vercel setting `PLATFORM_ADMIN_EMAILS` (comma-separated) are platform admins.
- **Organization switcher** in the top bar: work inside any organization as its owner would.
- **Platform** page:
  - create organizations;
  - assign new devices to an organization;
  - move a machine between organizations.
- The first time a platform admin signs in, they get an owner account in the first organization
  ("Veristart Lab").

### Setting up a new customer
1. **Platform** → *Create organization* (e.g. "ABC Civil Ltd.").
2. Pick it in the top-bar switcher → **View**.
3. **Users** → add their first **owner** by email. They get a "you've been added" email and sign in.
4. **Platform** → assign their devices to them.

## New devices

A device that reports for the first time is **unclaimed**: its data is stored, but no customer sees it,
and its check-in page says "not set up". A platform admin assigns it on the **Platform** page.

Moving a machine to another organization clears its approved-operator list and checks out whoever is
on it. Past check-ins and alerts stay with the organization they happened in.

## Operators: no more "two Johns" problem

Operator names are just labels. They can repeat freely, even within one organization.
- **Employee # (optional)**, unique within an organization, tells two "John Smith"s apart on screen.
- **PINs** are unique within an organization only. The QR code on a machine tells us which
  organization, so ABC Civil and XYZ Paving can both have an operator with PIN 1234.

## Alert emails

Each organization's alerts go to its active **owners and managers**. `ALERT_EMAIL_TO` in Vercel is now
optional: those addresses get every organization's alerts (for Veristart staff). Per-user alert
subscriptions (pick alert types and machines) come next.

## Coming next

- **Divisions:** optional groups of machines within an organization, with users limited to their division.
- **Alert subscriptions per user.**
- **Projects / jobsites**, with machine assignment history for reports.
