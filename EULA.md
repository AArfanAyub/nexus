<!-- Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. -->

# NEXUS — End User Terms

These terms apply to every person who installs or uses NEXUS ("you"). They sit
alongside `LICENSE`, which governs the license itself.

## 1. What you are getting

NEXUS is an offline desktop application for accounting, inventory, purchasing,
sales and CRM. It runs entirely on your computer. There is no account with us,
no cloud component and no server that can read your data.

- **Perpetual**: your right to use the version you licensed does not expire.
- **Offline**: the application makes no network requests at runtime.
- **No telemetry**: no crash reports, usage statistics or identifiers are sent
  anywhere. The only outbound traffic the software is capable of is the local
  development server while a developer runs `npm run dev`.

## 2. Your machine

An activation key is bound to one machine identifier, derived from your
computer's hostname, operating system, architecture and network adapter. If you
replace hardware you may re-activate the same key on the new machine; the
software will warn you but will not lock you out.

## 3. Your data is yours

All company data, documents and attachments live in a single database file in
your Windows user profile (`%APPDATA%\nexus\nexus.db`). You may copy, back up
and move that file. We cannot recover it for you and we cannot read it.

**Back it up.** The software includes a backup feature; use it. You are
responsible for retention of your statutory accounting records.

## 4. Your responsibilities

- Review financial output before relying on it. The software performs exact
  integer arithmetic and produces balanced double-entry ledgers, but the
  classification of a transaction is your decision.
- Keep your administrator password safe. Passwords are stored as scrypt hashes
  and cannot be recovered — only reset by another administrator.
- Do not attempt to defeat the license mechanism. It exists to keep the
  business honest, not to police you: a detected clock rollback only shows a
  warning banner and never blocks your work.

## 5. Support and updates

This license does not include a support or update entitlement unless purchased
separately. There is no auto-update mechanism in the application.

## 6. Acceptance

Installing, copying or using the software means you accept these terms and the
terms of `LICENSE`. If you do not accept them, do not install the software.
