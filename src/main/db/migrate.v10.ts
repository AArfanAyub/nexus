/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * v10 — backfill the currency catalogue.
 *
 * The catalogue grew after the first installs shipped, so a company created
 * before it existed had three currencies and no MYR. This migration makes every
 * named currency available without touching a row the company already uses:
 * is_base and rate_bp are preserved, only name/symbol/decimals are corrected.
 */

export const MIGRATION_V10_SQL = `

-- v10: every currency the product can name exists in every company, including
-- companies created before the catalogue existed. Existing rows are untouched, so
-- a company that already uses USD as its base keeps it.
INSERT INTO currencies (code, name, symbol, decimals, rate_bp, is_base, updated_at)
VALUES
  ('MYR', 'Malaysian ringgit', 'RM', 2, 10000, 0, datetime('now')),
  ('USD', 'US dollar', '$', 2, 10000, 0, datetime('now')),
  ('EUR', 'Euro', '€', 2, 10000, 0, datetime('now')),
  ('GBP', 'Pound sterling', '£', 2, 10000, 0, datetime('now')),
  ('SGD', 'Singapore dollar', 'S$', 2, 10000, 0, datetime('now')),
  ('IDR', 'Indonesian rupiah', 'Rp', 2, 10000, 0, datetime('now')),
  ('THB', 'Thai baht', '฿', 2, 10000, 0, datetime('now')),
  ('PHP', 'Philippine peso', '₱', 2, 10000, 0, datetime('now')),
  ('VND', 'Vietnamese dong', '₫', 0, 10000, 0, datetime('now')),
  ('INR', 'Indian rupee', '₹', 2, 10000, 0, datetime('now')),
  ('AED', 'UAE dirham', 'د.إ', 2, 10000, 0, datetime('now')),
  ('SAR', 'Saudi riyal', '﷼', 2, 10000, 0, datetime('now')),
  ('CNY', 'Chinese yuan', '¥', 2, 10000, 0, datetime('now')),
  ('JPY', 'Japanese yen', '¥', 0, 10000, 0, datetime('now')),
  ('KRW', 'South Korean won', '₩', 0, 10000, 0, datetime('now')),
  ('AUD', 'Australian dollar', 'A$', 2, 10000, 0, datetime('now')),
  ('CAD', 'Canadian dollar', 'C$', 2, 10000, 0, datetime('now')),
  ('ZAR', 'South African rand', 'R', 2, 10000, 0, datetime('now')),
  ('BRL', 'Brazilian real', 'R$', 2, 10000, 0, datetime('now')),
  ('MXN', 'Mexican peso', 'MX$', 2, 10000, 0, datetime('now'))
ON CONFLICT(code) DO UPDATE SET
  name = excluded.name,
  symbol = excluded.symbol,
  decimals = excluded.decimals;
`;
