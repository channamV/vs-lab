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
  - pair devices with customers' machines, unpair them, and move devices between Veristart's stock and a
    customer's spares (see [machines-and-devices.md](machines-and-devices.md)).
- The first time a platform admin signs in, they get an owner account in the first organization
  ("Veristart Lab").

### Setting up a new customer
1. **Platform** → *Create organization* (e.g. "ABC Civil Ltd.").
2. Pick it in the top-bar switcher → **View**.
3. **Users** → add their first **owner** by email. They get a "you've been added" email and sign in.
4. Add their machines (**Fleet → Add machine**, or let them do it), then **Platform** → pair a device with each.

## New devices

A device that reports for the first time is in **Veristart stock**: its data is stored, but no customer
sees it. A platform admin pairs it with a customer's machine on the **Platform** page. Machines belong to
one organization and don't move between organizations; devices do. Details:
[machines-and-devices.md](machines-and-devices.md).

## Operators: no more "two Johns" problem

Operator names are just labels. They can repeat freely, even within one organization.
- **Employee # (optional)**, unique within an organization, tells two "John Smith"s apart on screen.
- **PINs** are unique within an organization only. The QR code on a machine tells us which
  organization, so ABC Civil and XYZ Paving can both have an operator with PIN 1234.

## Divisions (optional)

For companies split into regions or business units, e.g. "Ontario" and "Quebec", or "Paving" and "Earthworks".
A company that doesn't need them simply doesn't create any.

- **Owners** create, rename and delete divisions at the bottom of the **Users** page.
- Each **machine** goes in one division, or none. Set it under *Machine details* on the machine's page,
  or when adding the machine.
- On the **Users** page, tick divisions for a manager or viewer to **limit** them to those divisions. They then see
  only those divisions' machines, plus the check-ins and alerts on them, and only get those machines' alert emails.
  They can only put new machines in their own divisions. **Nothing ticked = the whole company.**
- **Owners always see the whole company**, as do Veristart staff.
- Machines with no division are only seen by people with access to the whole company.
- **Operators** belong to the whole company, since people move between divisions. Who may run which machine is
  still set per machine (*Approved operators*).
- A division can only be deleted once it's empty. Move its machines out and un-tick it for any users first.
  Otherwise those users would suddenly see the whole company.

## Alert emails

Each person chooses which alerts they get (**Alerts → My alert emails**; owners can set anyone's from the Users
page). Owners and managers start with every alert. People are only emailed about machines they can see.
Details: [alerts.md](alerts.md#who-gets-alert-emails-subscriptions). `ALERT_EMAIL_TO` in Vercel is now
optional: those addresses get every organization's alerts (for Veristart staff).

## Coming next

- **Projects / jobsites**, with machine assignment history for reports.
