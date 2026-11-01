"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GENESIS_HASH = void 0;
exports.canonicalJson = canonicalJson;
exports.computeHash = computeHash;
exports.append = append;
exports.list = list;
exports.verify = verify;
exports.bySeq = bySeq;
exports.countForEntity = countForEntity;
/**
 * The append-only, hash-chained audit log (ARCHITECTURE §F.1 T1, BR-21).
 *
 *   hash = sha256(prev_hash + canonical_json({seq, actor, action, entity,
 *                                             entity_id, before, after, at}))
 *
 * There is no UPDATE and no DELETE path for `audit_log` anywhere in the
 * codebase. `verify()` reports the first sequence number whose recomputed hash
 * no longer matches, which is what makes a silent edit visible.
 */
const node_crypto_1 = require("node:crypto");
const dates_1 = require("../../shared/dates");
const connection_1 = require("../db/connection");
/** Hash of the entry before the first entry. */
exports.GENESIS_HASH = '0'.repeat(64);
/** Stable JSON: keys sorted, `undefined` dropped. Two equal objects hash equal. */
function canonicalJson(value) {
    if (value === null || value === undefined)
        return 'null';
    if (typeof value === 'number')
        return Number.isFinite(value) ? String(value) : 'null';
    if (typeof value === 'boolean')
        return value ? 'true' : 'false';
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
    if (typeof value === 'object') {
        const record = value;
        const keys = Object.keys(record)
            .filter((key) => record[key] !== undefined)
            .sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    return 'null';
}
function sha256(text) {
    return (0, node_crypto_1.createHash)('sha256').update(text, 'utf8').digest('hex');
}
function toEntry(row) {
    return {
        seq: Number(row.seq),
        id: row.id,
        actorId: row.actor_id,
        actorName: row.actor_name,
        at: row.at,
        entity: row.entity,
        entityId: row.entity_id,
        action: row.action,
        before: row.before_json === null ? null : JSON.parse(row.before_json),
        after: row.after_json === null ? null : JSON.parse(row.after_json),
        meta: row.meta_json === null ? null : JSON.parse(row.meta_json),
        prevHash: row.prev_hash,
        hash: row.hash,
    };
}
/** The hash an entry must have, given the previous hash. */
function computeHash(input) {
    const body = canonicalJson({
        seq: input.seq,
        actor: input.actorName,
        actor_id: input.actorId,
        action: input.action,
        entity: input.entity,
        entity_id: input.entityId,
        before: input.before ?? null,
        after: input.after ?? null,
        at: input.at,
    });
    return sha256(`${input.prevHash}${body}`);
}
/**
 * Appends one entry. Must be called INSIDE the caller's transaction so that a
 * rolled-back business operation leaves no audit row behind (CONVENTIONS §8).
 */
function append(input) {
    const database = (0, connection_1.conn)();
    const previous = database.one('SELECT hash, seq FROM audit_log ORDER BY seq DESC LIMIT 1');
    const prevHash = previous?.hash ?? exports.GENESIS_HASH;
    const seq = (previous ? Number(previous.seq) : 0) + 1;
    const at = input.at ?? (0, dates_1.nowIso)();
    const entityId = input.entityId ?? null;
    const id = (0, node_crypto_1.randomUUID)();
    const hash = computeHash({
        seq,
        actorId: input.actorId,
        actorName: input.actorName,
        action: input.action,
        entity: input.entity,
        entityId,
        before: input.before ?? null,
        after: input.after ?? null,
        at,
        prevHash,
    });
    database.run(`INSERT INTO audit_log
       (seq, id, actor_id, actor_name, at, entity, entity_id, action,
        before_json, after_json, meta_json, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        seq,
        id,
        input.actorId,
        input.actorName,
        at,
        input.entity,
        entityId,
        input.action,
        input.before === undefined ? null : canonicalJson(input.before),
        input.after === undefined ? null : canonicalJson(input.after),
        input.meta === undefined ? null : canonicalJson(input.meta),
        prevHash,
        hash,
    ]);
    return {
        seq,
        id,
        actorId: input.actorId,
        actorName: input.actorName,
        at,
        entity: input.entity,
        entityId,
        action: input.action,
        before: input.before ?? null,
        after: input.after ?? null,
        meta: input.meta ?? null,
        prevHash,
        hash,
    };
}
/** Filtered, paged read for the audit viewer (US-53). */
function list(query = {}) {
    const database = (0, connection_1.conn)();
    const where = [];
    const params = [];
    if (query.actorId) {
        where.push('actor_id = ?');
        params.push(query.actorId);
    }
    if (query.entity) {
        where.push('entity = ?');
        params.push(query.entity);
    }
    if (query.entityId) {
        where.push('entity_id = ?');
        params.push(query.entityId);
    }
    if (query.action) {
        where.push('action = ?');
        params.push(query.action);
    }
    if (query.from) {
        where.push('at >= ?');
        params.push(query.from);
    }
    if (query.to) {
        where.push('at <= ?');
        params.push(query.to);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const offset = Math.max(query.offset ?? 0, 0);
    const rows = database.all(`SELECT seq, id, actor_id, actor_name, at, entity, entity_id, action,
            before_json, after_json, meta_json, prev_hash, hash
       FROM audit_log ${clause}
      ORDER BY seq DESC
      LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const totalRow = database.one(`SELECT COUNT(*) AS total FROM audit_log ${clause}`, params);
    return { rows: rows.map(toEntry), total: totalRow ? Number(totalRow.total) : 0 };
}
/**
 * Recomputes the whole chain. `{ok:true}` means every row still hashes to the
 * value stored beside it and every `prev_hash` points at its predecessor.
 */
function verify() {
    const rows = (0, connection_1.conn)().all(`SELECT seq, id, actor_id, actor_name, at, entity, entity_id, action,
            before_json, after_json, meta_json, prev_hash, hash
       FROM audit_log ORDER BY seq ASC`);
    let expectedPrev = exports.GENESIS_HASH;
    for (const row of rows) {
        if (row.prev_hash !== expectedPrev) {
            return { ok: false, checked: rows.length, brokenAtSeq: Number(row.seq) };
        }
        const recomputed = computeHash({
            seq: Number(row.seq),
            actorId: row.actor_id,
            actorName: row.actor_name,
            action: row.action,
            entity: row.entity,
            entityId: row.entity_id,
            before: row.before_json === null ? null : JSON.parse(row.before_json),
            after: row.after_json === null ? null : JSON.parse(row.after_json),
            at: row.at,
            prevHash: row.prev_hash,
        });
        if (recomputed !== row.hash) {
            return { ok: false, checked: rows.length, brokenAtSeq: Number(row.seq) };
        }
        expectedPrev = row.hash;
    }
    return { ok: true, checked: rows.length };
}
/** One entry by sequence number, for the diff panel. */
function bySeq(seq) {
    const row = (0, connection_1.conn)().one(`SELECT seq, id, actor_id, actor_name, at, entity, entity_id, action,
            before_json, after_json, meta_json, prev_hash, hash
       FROM audit_log WHERE seq = ?`, [seq]);
    return row ? toEntry(row) : null;
}
/** Number of audit rows, used to refuse a hard delete (BR-22). */
function countForEntity(entity, entityId) {
    const row = (0, connection_1.conn)().one('SELECT COUNT(*) AS total FROM audit_log WHERE entity = ? AND entity_id = ?', [entity, entityId]);
    return row ? Number(row.total) : 0;
}
//# sourceMappingURL=audit.js.map