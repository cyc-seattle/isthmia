// A Directus hook extension, mounted into Directus as-is: CommonJS, with no imports, since an
// extension's folder has no node_modules of its own.
//
// Directus checks only that a filter's or sort's field is readable on *some* row, then runs it
// against the raw column, and joins a relational filter's rows with no permissions at all. So a
// Community viewer who sees a teammate by name could probe the teammate's hidden email letter by
// letter. This rejects any query from the Community role that filters, sorts, groups, or
// aggregates on a field it can't read on every row, or that crosses a relation into a collection
// whose rows it reads only in part. Search is left alone: Directus applies permissions to it.

const OPERATOR_RELATIONS = ["_some", "_none"];

/** A `DirectusError` by duck type, which Directus's error handler answers with its status. */
function forbidden(reason) {
  const error = new Error(`Community queries can't use ${reason}.`);
  error.name = "DirectusError";
  error.code = "FORBIDDEN";
  error.status = 403;
  error.extensions = { reason };
  return error;
}

function relatedCollection(relations, collection, field) {
  for (const relation of relations) {
    if (relation.collection === collection && relation.field === field && relation.related_collection) {
      return relation.related_collection;
    }
    if (relation.related_collection === collection && relation.meta?.one_field === field) {
      return relation.collection;
    }
  }
  return undefined;
}

/** `year(date_created)` filters on `date_created`. */
function fieldName(key) {
  const match = /^\w+\((\w+)\)$/.exec(key);
  return match ? match[1] : key;
}

/**
 * Returns why `query` on `collection` would reveal a field the viewer can't read, or undefined.
 *
 * @param config `role`: the Community role's ID. `restricted`: per collection, the fields some Community read rule withholds.
 *   `open`: the collections every Community read rule returns whole.
 */
function violation(config, relations, collection, query) {
  function checkField(current, key) {
    const field = fieldName(key);
    if ((config.restricted[current] ?? []).includes(field)) {
      return `${current}.${field}`;
    }
    return undefined;
  }

  function step(current, key) {
    if (key.startsWith("$FOLLOW") || key.includes(":")) {
      return { reason: `the relation ${key}` };
    }
    const restricted = checkField(current, key);
    if (restricted) return { reason: restricted };
    const target = relatedCollection(relations, current, key);
    if (!target || !config.open.includes(target)) {
      return { reason: `the relation ${current}.${key}` };
    }
    return { target };
  }

  function checkFilter(current, filter) {
    if (filter === null || typeof filter !== "object") return undefined;
    for (const [key, value] of Object.entries(filter)) {
      if (key === "_and" || key === "_or") {
        for (const branch of value) {
          const reason = checkFilter(current, branch);
          if (reason) return reason;
        }
        continue;
      }
      if (key.startsWith("_")) continue;
      const nested =
        value !== null &&
        typeof value === "object" &&
        Object.keys(value).some((inner) => !inner.startsWith("_") || OPERATOR_RELATIONS.includes(inner));
      if (!nested) {
        const reason = checkField(current, key);
        if (reason) return reason;
        continue;
      }
      const { target, reason } = step(current, key);
      if (reason) return reason;
      const inner = Object.keys(value).find((k) => OPERATOR_RELATIONS.includes(k)) ? Object.values(value)[0] : value;
      const innerReason = checkFilter(target, inner);
      if (innerReason) return innerReason;
    }
    return undefined;
  }

  function checkPath(path) {
    const parts = path.replace(/^-/, "").split(".");
    let current = collection;
    for (const part of parts.slice(0, -1)) {
      const { target, reason } = step(current, part);
      if (reason) return reason;
      current = target;
    }
    return checkField(current, parts.at(-1));
  }

  const aliases = query.alias ?? {};
  const paths = [...(query.sort ?? []), ...(query.group ?? []), ...Object.values(query.aggregate ?? {}).flat()].map(
    (path) => aliases[path.replace(/^-/, "")] ?? path,
  );

  if (query.deep && Object.keys(query.deep).length > 0) return "deep";
  const reason = checkFilter(collection, query.filter);
  if (reason) return reason;
  for (const path of paths) {
    if (path === "*") continue;
    const pathReason = checkPath(path);
    if (pathReason) return pathReason;
  }
  return undefined;
}

function register({ filter }) {
  // Written beside this file by `crm`, from community-rules.ts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Directus loads this file as CommonJS.
  const config = require("./config.json");
  filter("items.query", (query, { collection }, { accountability, schema }) => {
    if (!accountability || accountability.admin || accountability.role !== config.role) return query;
    const reason = violation(config, schema.relations, collection, query);
    if (reason) throw forbidden(reason);
    return query;
  });
}

module.exports = register;
module.exports.violation = violation;
