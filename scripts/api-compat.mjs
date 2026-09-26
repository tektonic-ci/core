#!/usr/bin/env node
// Checks @tektonic-ci/core's public API against the last published release, without
// knowing anything about the packages that consume it. Anyone can write a provider, so
// "does every provider still build" is not a question core can answer. What core can
// answer is whether code written against the published version — any code, implementing
// or calling — still compiles against this one. Two parts:
//
// 1. The API report (packages/tektonic/api/*.api.md): every export's declaration, as the
//    compiler emits it. `check` fails when it no longer matches the build, so a change to
//    the public surface is always a reviewed diff. `update` rewrites it.
//
// 2. The compatibility check: fetch the baseline's declarations from npm and have tsc
//    compile a generated file that asks, export by export, whether the old API's uses
//    still type-check against the new one. A break fails the check unless
//    packages/tektonic/package.json already bumps the major.
//
// Interfaces and type aliases are checked in both directions: an implementation of the
// old StatusReporter must satisfy the new one, and a value of the new type must still be
// accepted where the old type was. That makes every type strict, so an extension point
// needs no marking, and a forgotten annotation cannot weaken the check. The cost is that a
// new required member on a type core only ever hands out is reported as breaking too.
//
// Usage: node scripts/api-compat.mjs check|update
//   API_BASELINE=<version or directory>  compare against this instead of npm's `latest`
//
// typescript-api is TypeScript 5 under an alias: TS 7 ships only the native compiler,
// without the JS API, and this script needs the API to enumerate exports. tsc 7 remains
// the judge of the generated file.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript-api");

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const pkgDir = path.join(root, "packages/tektonic");
const reportDir = path.join(pkgDir, "api");
const work = path.join(pkgDir, ".api-compat");
const pkgName = "@tektonic-ci/core";

const mode = process.argv[2];
if (mode !== "check" && mode !== "update") {
    console.error("usage: api-compat.mjs check|update");
    process.exit(2);
}

// ─── Entry points ────────────────────────────────────────────────────────────

/** `{ ".": "dist/index.d.ts", "./testing": … }` from a package.json's `exports`. */
function entries(dir) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const out = {};
    for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
        if (target && typeof target === "object" && target.types) out[sub] = target.types;
    }
    if (!out["."] && pkg.types) out["."] = pkg.types;
    return { version: pkg.version, entries: out };
}

/** File-name-safe label for an entry: "." → "core", "./testing" → "testing". */
const label = (sub) => (sub === "." ? "core" : sub.replace(/^\.\//, "").replace(/\//g, "-"));

// ─── Reading exports ─────────────────────────────────────────────────────────

function program(files) {
    return ts.createProgram(files, {
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        target: ts.ScriptTarget.ES2020,
    });
}

/**
 * Every export of an entry file, resolved through its re-exports. `kind` drives which
 * checks apply; `typeParams` is how many type arguments a reference needs.
 */
function readExports(prog, file) {
    const checker = prog.getTypeChecker();
    const sf = prog.getSourceFile(file);
    if (!sf) throw new Error(`cannot read ${file}`);
    const mod = checker.getSymbolAtLocation(sf);
    const out = new Map();
    for (const exp of checker.getExportsOfModule(mod)) {
        const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
        const f = sym.flags;
        const decls = sym.declarations ?? [];
        const typeDecl = decls.find(
            (d) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d),
        );
        out.set(exp.name, {
            name: exp.name,
            isClass: !!(f & ts.SymbolFlags.Class),
            isFunction: !!(f & ts.SymbolFlags.Function),
            isVariable: !!(f & ts.SymbolFlags.Variable),
            isType: !!(f & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)),
            abstract: decls.some(
                (d) => ts.isClassDeclaration(d) && ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Abstract,
            ),
            typeParams: typeDecl?.typeParameters?.length ?? 0,
            decls,
        });
    }
    return out;
}

// ─── Part 1: the API report ──────────────────────────────────────────────────

const printer = ts.createPrinter({ removeComments: true });

/** A class declaration without its private members, which are not API. */
function publicClass(decl) {
    const members = decl.members.filter(
        (m) =>
            !(ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Private) &&
            !(m.name && ts.isPrivateIdentifier(m.name)),
    );
    return ts.factory.updateClassDeclaration(
        decl,
        decl.modifiers,
        decl.name,
        decl.typeParameters,
        decl.heritageClauses,
        members,
    );
}

function widenedType(decl) {
    const t = decl.type;
    if (t && ts.isLiteralTypeNode(t)) {
        if (ts.isStringLiteral(t.literal)) return "string";
        if (ts.isNumericLiteral(t.literal)) return "number";
        return "boolean";
    }
    return t ? printer.printNode(ts.EmitHint.Unspecified, t, decl.getSourceFile()) : "unknown";
}

function report(prog, file, sub) {
    const exps = [...readExports(prog, file).values()].sort((a, b) => a.name.localeCompare(b.name));
    const lines = [
        `# ${sub === "." ? pkgName : pkgName + sub.slice(1)}`,
        "",
        "<!-- Generated by scripts/api-compat.mjs. Run `npm run api:update` after a public API change. -->",
        "",
    ];
    for (const e of exps) {
        const text = e.decls
            .map((d) => {
                const node = ts.isClassDeclaration(d) ? publicClass(d) : d;
                // A variable prints as its whole statement, so `declare const X: …` reads as TS,
                // with a literal type widened: the value is not API (an image pin would
                // otherwise make every Renovate bump a report change).
                const printed = ts.isVariableDeclaration(d)
                    ? `declare const ${d.name.getText()}: ${widenedType(d)};`
                    : printer.printNode(ts.EmitHint.Unspecified, node, d.getSourceFile());
                return printed.replace(/^export /, "");
            })
            .join("\n");
        lines.push(`## ${e.name}`, "", "```ts", text, "```", "");
    }
    return lines.join("\n");
}

// ─── Part 2: the compatibility check ─────────────────────────────────────────

/**
 * Copy a tree of .d.ts files with private and protected class members removed. Two
 * copies of a class with a private member are nominally distinct to tsc, so without this
 * every type that mentions a class would read as incompatible with itself. Protected
 * members go too: subclassing core's classes is not a supported extension mechanism.
 */
function copyStripped(srcDir, destDir) {
    for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const src = path.join(srcDir, ent.name);
        const dest = path.join(destDir, ent.name);
        if (ent.isDirectory()) {
            if (ent.name === "cli") continue;
            copyStripped(src, dest);
            continue;
        }
        if (!ent.name.endsWith(".d.ts")) continue;
        const sf = ts.createSourceFile(src, fs.readFileSync(src, "utf8"), ts.ScriptTarget.Latest, true);
        const strip = (ctx) => (node) => {
            const visit = (n) => {
                if (ts.isClassDeclaration(n)) {
                    const members = n.members.filter(
                        (m) =>
                            !(ts.getCombinedModifierFlags(m) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) &&
                            !(m.name && ts.isPrivateIdentifier(m.name)),
                    );
                    return ts.factory.updateClassDeclaration(
                        n, n.modifiers, n.name, n.typeParameters, n.heritageClauses, members,
                    );
                }
                return ts.visitEachChild(n, visit, ctx);
            };
            return ts.visitNode(node, visit);
        };
        const out = ts.transform(sf, [strip]).transformed[0];
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(dest, ts.createPrinter().printFile(out));
    }
}

const HELPERS = `
type CtorArgs<T> = T extends abstract new (...args: infer A) => any ? A : never;
type Widen<T> = T extends string ? string : T extends number ? number : T extends boolean ? boolean
    : T extends (...args: any[]) => any ? T
    : T extends object ? { [K in keyof T]: Widen<T[K]> } : T;
type Statics<T> = Omit<T, "prototype">;
`;

/**
 * One generated check per line, so a tsc diagnostic's line number names the export and
 * the rule it broke. Each check is an assignment: source must be assignable to target.
 */
function checksFor(e, ns) {
    const args = e.typeParams ? `<${Array(e.typeParams).fill("any").join(", ")}>` : "";
    const O = `Old${ns}.${e.name}`;
    const N = `New${ns}.${e.name}`;
    const out = [];
    const add = (rule, source, target) => out.push({ export: e.name, rule, source, target });
    if (e.isClass) {
        add("constructor still accepts the old arguments", `CtorArgs<typeof ${O}>`, `CtorArgs<typeof ${N}>`);
        add("instances still usable as the old type", `${N}${args}`, `${O}${args}`);
        add("no public member removed", `keyof ${O}${args}`, `keyof ${N}${args}`);
        add("static members still compatible", `Statics<typeof ${N}>`, `Statics<typeof ${O}>`);
        return out;
    }
    if (e.isFunction) add("still callable as before", `typeof ${N}`, `typeof ${O}`);
    else if (e.isVariable) {
        // Widened: a changed literal value (an image pin, a path) is a behaviour change, not
        // a type break, and would otherwise report every Renovate bump as breaking.
        add("still usable as before", `Widen<typeof ${N}>`, `Widen<typeof ${O}>`);
    }
    if (e.isType) {
        add("old values still accepted (and old implementations still satisfy it)", `${O}${args}`, `${N}${args}`);
        add("new values still usable as the old type", `${N}${args}`, `${O}${args}`);
        add("no member removed", `keyof ${O}${args}`, `keyof ${N}${args}`);
    }
    return out;
}

function fetchBaseline() {
    const spec = process.env.API_BASELINE;
    if (spec && fs.existsSync(spec)) return path.resolve(spec);
    const version = spec || JSON.parse(
        execFileSync("npm", ["view", `${pkgName}@latest`, "version", "--json"], { encoding: "utf8" }),
    );
    const dest = path.join(work, "baseline");
    fs.mkdirSync(dest, { recursive: true });
    const [{ filename }] = JSON.parse(
        execFileSync("npm", ["pack", `${pkgName}@${version}`, "--json", "--pack-destination", dest], {
            encoding: "utf8",
        }),
    );
    execFileSync("tar", ["xzf", path.join(dest, filename), "-C", dest]);
    return path.join(dest, "package");
}

function compat() {
    const baseDir = fetchBaseline();
    const base = entries(baseDir);
    const cur = entries(pkgDir);
    const major = (v) => Number(v.split(".")[0]);
    const majorBumped = major(cur.version) > major(base.version);

    fs.rmSync(path.join(work, "old"), { recursive: true, force: true });
    fs.rmSync(path.join(work, "new"), { recursive: true, force: true });
    copyStripped(path.join(baseDir, "dist"), path.join(work, "old"));
    copyStripped(path.join(pkgDir, "dist"), path.join(work, "new"));

    const findings = [];
    const added = [];
    const checks = [];
    const imports = [];
    Object.keys(base.entries).forEach((sub, i) => {
        if (!cur.entries[sub]) {
            findings.push({ export: sub, rule: "entry point removed", message: `${pkgName}${sub.slice(1)} is gone` });
            return;
        }
        const rel = (e) => "./" + e.replace(/^(\.\/)?dist\//, "").replace(/\.d\.ts$/, "");
        imports.push(`import type * as Old${i} from "./old/${rel(base.entries[sub]).slice(2)}";`);
        imports.push(`import type * as New${i} from "./new/${rel(cur.entries[sub]).slice(2)}";`);
        const oldFile = path.join(work, "old", base.entries[sub].replace(/^(\.\/)?dist\//, ""));
        const newFile = path.join(work, "new", cur.entries[sub].replace(/^(\.\/)?dist\//, ""));
        const prog = program([oldFile, newFile]);
        const olds = readExports(prog, oldFile);
        const news = readExports(prog, newFile);
        for (const e of olds.values()) {
            if (!news.has(e.name)) {
                findings.push({ export: e.name, rule: "export removed", message: `no longer exported from ${sub}` });
                continue;
            }
            checks.push(...checksFor(e, i));
        }
        for (const name of news.keys()) if (!olds.has(name)) added.push(`${sub === "." ? "" : sub + " "}${name}`);
    });

    const header = [...imports, HELPERS];
    const body = checks.map((c, j) => `declare const s${j}: ${c.source}; const t${j}: ${c.target} = s${j};`);
    fs.writeFileSync(path.join(work, "compat.ts"), [...header, ...body].join("\n") + "\n");
    fs.writeFileSync(
        path.join(work, "tsconfig.json"),
        JSON.stringify({
            compilerOptions: {
                strict: true, noEmit: true, skipLibCheck: true, types: ["node"],
                module: "commonjs", moduleResolution: "node10", target: "ES2020",
                noUnusedLocals: false,
            },
            files: ["compat.ts"],
        }, null, 2),
    );

    let output = "";
    try {
        execFileSync(path.join(root, "node_modules/.bin/tsc"), ["-p", work, "--pretty", "false"], {
            encoding: "utf8",
        });
    } catch (err) {
        output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    const firstCheckLine = header.join("\n").split("\n").length + 1;
    for (const block of output.split(/\n(?=\S)/)) {
        const m = block.match(/compat\.ts\((\d+),\d+\): error (TS\d+): ([\s\S]*)/);
        if (!m) {
            if (block.trim()) findings.push({ export: "(compat file)", rule: "tsc error", message: block.trim() });
            continue;
        }
        const c = checks[Number(m[1]) - firstCheckLine];
        if (!c) {
            findings.push({ export: "(compat file)", rule: m[2], message: m[3].trim() });
            continue;
        }
        // tsc names each side by its absolute import path; old/new is all that matters.
        const msg = m[3]
            .replace(/import\("[^"]*\/\.api-compat\/(old|new)\/[^"]*"\)\./g, "$1.")
            .trim()
            .split("\n")
            .slice(0, 4)
            .join("\n    ");
        findings.push({ export: c.export, rule: c.rule, message: msg });
    }

    console.log(`api-compat: ${pkgName}@${base.version} (baseline) → ${cur.version} (this tree), ${checks.length} checks`);
    if (added.length) console.log(`  added (additive, a minor at least): ${added.join(", ")}`);
    if (!findings.length) {
        console.log("  no breaking changes");
        return true;
    }
    console.log(`  ${findings.length} breaking:`);
    for (const f of findings) console.log(`  ✗ ${f.export} — ${f.rule}\n    ${f.message}`);
    if (majorBumped) {
        console.log(`  allowed: ${cur.version} bumps the major over ${base.version}`);
        return true;
    }
    console.log(
        `  Bump the major in packages/tektonic/package.json, or make the change additive ` +
            `(an optional member, a new overload, a new export).`,
    );
    return false;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const cur = entries(pkgDir);
const reportProg = program(Object.values(cur.entries).map((e) => path.join(pkgDir, e)));
let ok = true;
fs.mkdirSync(reportDir, { recursive: true });
for (const [sub, file] of Object.entries(cur.entries)) {
    const want = report(reportProg, path.join(pkgDir, file), sub);
    const reportFile = path.join(reportDir, `${label(sub)}.api.md`);
    if (mode === "update") {
        fs.writeFileSync(reportFile, want);
        console.log(`api-compat: wrote ${path.relative(root, reportFile)}`);
    } else if (!fs.existsSync(reportFile) || fs.readFileSync(reportFile, "utf8") !== want) {
        console.log(`api-compat: ${path.relative(root, reportFile)} is out of date — run \`npm run api:update\` and commit it`);
        ok = false;
    }
}
if (mode === "check") ok = compat() && ok;
process.exit(ok ? 0 : 1);
