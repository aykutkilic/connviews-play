// The browser-only workspace: the app's server API (../server/server.mjs, workspace.mjs) answered from this service
// worker, with projects kept in IndexedDB. The hosted demo has no server; the page registers this worker (main.jsx) and
// every request below <scope>/api/ ends up here, so the editor, images, videos and downloads work as they do against
// the Node server. Building and deploying packages need a real machine and answer with an explanation.
//
// This file is plain JavaScript without imports: it is copied as it is (app/public) and must not need a bundler.

const APP_VERSION = "0.2.0";
const PREFIX = new URL("api/", self.registration.scope).pathname;
const PROJECT_FILE = "project.json";
const DIAGRAM_EXTENSION = ".diagram.json";
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,79}$/;
const SEGMENT = /^[^\\/:*?"<>|\u0000-\u001f]{1,120}$/;
const TYPES = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm",
	".csv": "text/csv; charset=utf-8", ".tsv": "text/tab-separated-values; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
	".gpx": "application/gpx+xml", ".geojson": "application/geo+json", ".wasm": "application/wasm", ".map": "application/json",
};

class WorkspaceError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
}

// ---- Storage: one key-value store (IndexedDB; a Map where IndexedDB is not available, e.g. some private windows).
//   j/<project>        { key, description, created, modified }
//   p/<project>/<path> { key, type: "file" | "dir", bytes?, size?, modified }
//   t/<id>             a deleted project or path, with the records it held
//   m/session          the editor's last state (text)

function memoryStore() {
	const map = new Map();
	return {
		get: async key => map.get(key),
		put: async record => void map.set(record.key, record),
		del: async key => void map.delete(key),
		scan: async prefix => [...map.values()].filter(record => record.key.startsWith(prefix)).sort((a, b) => (a.key < b.key ? -1 : 1)),
	};
}

function idbStore() {
	const opened = new Promise((resolve, reject) => {
		const request = indexedDB.open("connviews-demo", 1);
		request.onupgradeneeded = () => request.result.createObjectStore("kv", { keyPath: "key" });
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	const run = async (mode, action) => {
		const db = await opened;
		return new Promise((resolve, reject) => {
			const transaction = db.transaction("kv", mode);
			const result = action(transaction.objectStore("kv"));
			transaction.oncomplete = () => resolve(result.result);
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
	};
	return {
		get: key => run("readonly", store => store.get(key)),
		put: record => run("readwrite", store => store.put(record)),
		del: key => run("readwrite", store => store.delete(key)),
		scan: prefix => run("readonly", store => store.getAll(IDBKeyRange.bound(prefix, `${prefix}￿`))),
	};
}

let storePromise = null;
const getStore = () => (storePromise ??= (async () => {
	try {
		const store = idbStore();
		await store.get("probe");
		return store;
	} catch {
		return memoryStore();
	}
})());

// ---- The workspace.

function cleanPath(path, { allowEmpty = false } = {}) {
	const raw = String(path ?? "").replace(/\\/g, "/");
	if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new WorkspaceError("Paths are relative to the project");
	const parts = raw.split("/").filter(part => part && part !== ".");
	if (!parts.length && !allowEmpty) throw new WorkspaceError("A path is needed");
	for (const part of parts) {
		if (part === ".." || part.startsWith(".") || !SEGMENT.test(part) || part.endsWith(" ") || part.endsWith(".")) throw new WorkspaceError(`Not an allowed name: "${part}"`);
	}
	if (parts.join("/").length > 600) throw new WorkspaceError("The path is too long");
	return parts.join("/");
}

function cleanProjectName(name) {
	const trimmed = String(name ?? "").trim();
	if (!NAME.test(trimmed) || trimmed.endsWith(".")) throw new WorkspaceError("Project names use letters, digits, spaces and _ . ( ) -, start with a letter or digit, and have at most 80 characters");
	return trimmed;
}

const versionOf = record => `${Math.round(record.modified)}-${record.size ?? 0}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBytes = value => (typeof value === "string" ? encoder.encode(value) : new Uint8Array(value));
const fileRecord = (key, bytes) => ({ key, type: "file", bytes, size: bytes.byteLength, modified: Date.now() });
const emptyDiagram = () => ({ format: "connviews.diagram", version: 1, domain: "data", components: [], connections: [], layout: { freeNodes: {}, snapToGrid: true } });

async function workspace() {
	const store = await getStore();
	const pkey = (project, path = "") => `p/${project}/${path}`;

	const requireProject = async name => {
		const clean = cleanProjectName(name);
		if (!(await store.get(`j/${clean}`))) throw new WorkspaceError(`No project "${name}"`, 404);
		return clean;
	};
	/** The records of a project, as { path, record } (folders and files). */
	const records = async project => (await store.scan(pkey(project))).map(record => ({ path: record.key.slice(pkey(project).length), record }));
	const under = (path, folder) => path === folder || path.startsWith(`${folder}/`);

	const api = {
		async listProjects() {
			return (await store.scan("j/")).map(meta => ({ name: meta.key.slice(2), description: meta.description ?? "", created: meta.created ?? null, modified: new Date(meta.modified).toISOString() })).sort((a, b) => a.name.localeCompare(b.name));
		},

		async createProject(name, { description = "", diagrams, files = {} } = {}) {
			const clean = cleanProjectName(name);
			if (await store.get(`j/${clean}`)) throw new WorkspaceError(`"${clean}" exists already`, 409);
			const now = Date.now();
			await store.put({ key: `j/${clean}`, description, created: new Date(now).toISOString(), modified: now });
			for (const folder of ["diagrams", "data", "targets"]) await store.put({ key: pkey(clean, folder), type: "dir", modified: now });
			for (const [path, text] of Object.entries(files ?? {})) {
				if (typeof text !== "string") throw new WorkspaceError(`${path}: files are text`);
				await store.put(fileRecord(pkey(clean, cleanPath(path)), encoder.encode(text)));
			}
			const first = diagrams ?? (Object.keys(files ?? {}).some(path => path.endsWith(DIAGRAM_EXTENSION)) ? {} : { [`diagrams/main${DIAGRAM_EXTENSION}`]: emptyDiagram() });
			for (const [path, diagram] of Object.entries(first)) await store.put(fileRecord(pkey(clean, cleanPath(path)), encoder.encode(JSON.stringify(diagram, null, 2))));
			return { name: clean };
		},

		async renameProject(name, to) {
			const from = await requireProject(name);
			const clean = cleanProjectName(to);
			if (await store.get(`j/${clean}`)) throw new WorkspaceError(`"${clean}" exists already`, 409);
			const meta = await store.get(`j/${from}`);
			for (const { path, record } of await records(from)) {
				await store.put({ ...record, key: pkey(clean, path) });
				await store.del(record.key);
			}
			await store.put({ ...meta, key: `j/${clean}`, modified: Date.now() });
			await store.del(`j/${from}`);
			return { name: clean };
		},

		async deleteProject(name) {
			const project = await requireProject(name);
			const meta = await store.get(`j/${project}`);
			const held = await records(project);
			const id = await toTrash({ kind: "project", project, meta, entries: held.map(({ path, record }) => ({ path, record })) });
			for (const { record } of held) await store.del(record.key);
			await store.del(`j/${project}`);
			return { trash: id };
		},

		/** Every file and folder of a project: [{ path, type, size, modified, version }], folders first, each folder's content after it. */
		async tree(name) {
			const project = await requireProject(name);
			const byPath = new Map();
			for (const { path, record } of await records(project)) {
				const parts = path.split("/");
				for (let i = 1; i < parts.length; i++) {
					const folder = parts.slice(0, i).join("/");
					if (!byPath.has(folder)) byPath.set(folder, { path: folder, type: "dir" });
				}
				if (record.type === "dir") byPath.set(path, { path, type: "dir" });
				else byPath.set(path, { path, type: "file", size: record.size, modified: new Date(record.modified).toISOString(), version: versionOf(record) });
			}
			const children = new Map();
			for (const entry of byPath.values()) {
				const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
				if (!children.has(parent)) children.set(parent, []);
				children.get(parent).push(entry);
			}
			const name_ = entry => entry.path.slice(entry.path.lastIndexOf("/") + 1);
			const out = [];
			const walk = parent => {
				const list = (children.get(parent) ?? []).filter(entry => !name_(entry).startsWith(".") && !(parent === "" && entry.path === PROJECT_FILE));
				list.sort((a, b) => ((a.type === "dir") === (b.type === "dir") ? name_(a).localeCompare(name_(b)) : a.type === "dir" ? -1 : 1));
				for (const entry of list) {
					out.push(entry);
					if (entry.type === "dir") walk(entry.path);
				}
			};
			walk("");
			return out;
		},

		async readFile(name, path) {
			const project = await requireProject(name);
			const record = await store.get(pkey(project, cleanPath(path)));
			if (!record || record.type !== "file") throw new WorkspaceError(`No file ${path}`, 404);
			return { bytes: record.bytes, version: versionOf(record), modified: new Date(record.modified).toISOString() };
		},

		async writeFile(name, path, bytes, { ifVersion } = {}) {
			const project = await requireProject(name);
			const key = pkey(project, cleanPath(path));
			const existing = await store.get(key);
			if (existing?.type === "dir") throw new WorkspaceError(`${path} is a folder`, 409);
			if (ifVersion && existing && versionOf(existing) !== ifVersion) throw new WorkspaceError(`${path} was changed elsewhere`, 409);
			const record = fileRecord(key, bytes);
			if (existing && record.modified <= existing.modified) record.modified = existing.modified + 1;
			await store.put(record);
			await store.put({ ...(await store.get(`j/${project}`)), modified: record.modified });
			return { version: versionOf(record), modified: new Date(record.modified).toISOString() };
		},

		async makeFolder(name, path) {
			const project = await requireProject(name);
			const key = pkey(project, cleanPath(path));
			if (!(await store.get(key))) await store.put({ key, type: "dir", modified: Date.now() });
			return {};
		},

		async move(name, from, to) {
			const project = await requireProject(name);
			const source = cleanPath(from);
			const target = cleanPath(to);
			const held = (await records(project)).filter(({ path }) => under(path, source));
			if (!held.length) throw new WorkspaceError(`No ${from}`, 404);
			if ((await records(project)).some(({ path }) => under(path, target))) throw new WorkspaceError(`${to} exists already`, 409);
			if (target.startsWith(`${source}/`)) throw new WorkspaceError("A folder cannot move into itself");
			for (const { path, record } of held) {
				await store.put({ ...record, key: pkey(project, `${target}${path.slice(source.length)}`) });
				await store.del(record.key);
			}
			return { updated: await this.retarget(project, source, target) };
		},

		/** Points the blocks of every diagram in the project that name `from` at `to` (as the server does). */
		async retarget(name, from, to) {
			const clean = path => String(path ?? "").trim().replace(/^\.\//, "");
			const moved = path => (path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : null);
			const rewrite = diagram => {
				let changed = false;
				for (const component of diagram?.components ?? []) {
					const params = component.params ?? {};
					if (["projectFile", "diagramRef", "packageApp", "protocolEncode", "protocolDecode"].includes(component.block) && typeof params.path === "string") {
						const next = moved(clean(params.path));
						if (next) {
							params.path = next;
							changed = true;
						}
					}
					if (params.diagram && rewrite(params.diagram)) changed = true;
					// A deployment diagram's node (its target definition) and placed diagrams (their CAN pins' protocols).
					if (component.block === "deploymentNode" && params.settings && rewriteDeployment({ nodes: [params.settings] })) changed = true;
					if (component.block === "diagramRef" && params.placement?.pins && rewriteDeployment({ placements: [params.placement] })) changed = true;
				}
				// The diagram's nodes (their target definitions, their pins' protocols), as drawn and in each variant.
				for (const nodes of [diagram?.nodes, ...Object.values(diagram?.variants ?? {}).map(variant => variant?.nodes)]) {
					for (const binding of Object.values(nodes ?? {})) {
						if (binding && typeof binding === "object" && rewriteDeployment({ nodes: [binding], placements: [{ pins: binding.pins }] })) changed = true;
					}
				}
				return changed;
			};
			// Deployments name diagrams (placements), target definitions (nodes) and protocol files (CAN pins).
			const rewriteDeployment = deployment => {
				let changed = false;
				const swap = (holder, key) => {
					const next = typeof holder?.[key] === "string" ? moved(clean(holder[key])) : null;
					if (next) {
						holder[key] = next;
						changed = true;
					}
				};
				for (const node of deployment?.nodes ?? []) swap(node, "definition");
				for (const placement of deployment?.placements ?? []) {
					swap(placement, "component");
					for (const pin of Object.values(placement.pins ?? {})) if (pin && typeof pin === "object") swap(pin, "protocolPath");
				}
				return changed;
			};
			const updated = [];
			for (const { path, record } of await records(name)) {
				const deploymentFile = path.endsWith(".deploy.json");
				if (record.type !== "file" || !(path.endsWith(DIAGRAM_EXTENSION) || deploymentFile) || path.startsWith("build/")) continue;
				try {
					const data = JSON.parse(decoder.decode(record.bytes));
					if (deploymentFile ? rewriteDeployment(data) : rewrite(data)) {
						await store.put(fileRecord(record.key, encoder.encode(`${JSON.stringify(data, null, "\t")}\n`)));
						updated.push(path);
					}
				} catch {
					// Not a readable diagram: leave it.
				}
			}
			return updated;
		},

		async copy(name, from, to) {
			const project = await requireProject(name);
			const source = cleanPath(from);
			const target = cleanPath(to);
			const all = await records(project);
			const held = all.filter(({ path }) => under(path, source));
			if (!held.length) throw new WorkspaceError(`No ${from}`, 404);
			if (all.some(({ path }) => under(path, target))) throw new WorkspaceError(`${to} exists already`, 409);
			for (const { path, record } of held) await store.put({ ...record, key: pkey(project, `${target}${path.slice(source.length)}`), modified: Date.now() });
			return {};
		},

		async remove(name, path) {
			const project = await requireProject(name);
			const clean = cleanPath(path);
			const held = (await records(project)).filter(item => under(item.path, clean));
			if (!held.length) throw new WorkspaceError(`No ${path}`, 404);
			const id = await toTrash({ kind: "path", project, path: clean, entries: held.map(({ path: entry, record }) => ({ path: entry, record })) });
			for (const { record } of held) await store.del(record.key);
			return { trash: id };
		},

		async listTrash() {
			return (await store.scan("t/")).map(({ key, entries, ...manifest }) => manifest).sort((a, b) => String(b.deleted).localeCompare(String(a.deleted)));
		},

		async restore(id) {
			if (!/^[\w-]+$/.test(String(id))) throw new WorkspaceError("Bad trash id");
			const item = await store.get(`t/${id}`);
			if (!item) throw new WorkspaceError("Not in the trash", 404);
			let project = item.project;
			let top = item.kind === "project" ? "" : item.path;
			if (item.kind === "project") {
				for (let n = 2; await store.get(`j/${project}`); n++) project = `${item.project} (restored ${n})`;
				await store.put({ ...item.meta, key: `j/${project}` });
			} else {
				if (!(await store.get(`j/${project}`))) throw new WorkspaceError(`Restore the project ${project} first`, 409);
				const taken = candidate => store.scan(pkey(project, candidate)).then(found => found.some(record => under(record.key.slice(pkey(project).length), candidate)));
				for (let n = 2; await taken(top); n++) top = item.path.replace(/(\.[^./]+)?$/, (_, ext = "") => ` (restored ${n})${ext}`);
			}
			for (const { path, record } of item.entries) {
				const next = item.kind === "project" ? path : `${top}${path.slice(item.path.length)}`;
				await store.put({ ...record, key: pkey(project, next) });
			}
			await store.del(`t/${id}`);
			return { restored: item.kind === "project" ? project : `${project}/${top}` };
		},

		async readSession() {
			const record = await store.get("m/session");
			try {
				return record ? JSON.parse(record.text) : null;
			} catch {
				return null;
			}
		},

		async writeSession(session) {
			const text = JSON.stringify(session);
			if (text.length > 4 * 2 ** 20) throw new WorkspaceError("The session is too large");
			await store.put({ key: "m/session", text });
			return {};
		},

		async search(query, { project: only, limit = 60 } = {}) {
			const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
			if (!words.length) return [];
			const matches = text => words.every(word => String(text).toLowerCase().includes(word));
			const results = [];
			for (const { name } of await this.listProjects()) {
				if (only && name !== only) continue;
				if (matches(name)) results.push({ project: name, kind: "project", label: name, detail: "project" });
				const held = new Map((await records(name)).map(({ path, record }) => [path, record]));
				for (const entry of await this.tree(name)) {
					if (results.length >= limit) return results;
					if (matches(entry.path)) results.push({ project: name, path: entry.path, kind: entry.type === "dir" ? "folder" : "file", label: entry.path.split("/").pop(), detail: entry.path });
					if (entry.type !== "file" || !entry.path.endsWith(DIAGRAM_EXTENSION) || entry.size > 8 * 2 ** 20) continue;
					try {
						const diagram = JSON.parse(decoder.decode(held.get(entry.path).bytes));
						const visit = (components, trail) => {
							for (const component of components ?? []) {
								const label = component.name ?? component.id;
								if (matches(`${label} ${component.block}`)) results.push({ project: name, path: entry.path, kind: "block", label, detail: `${component.block} in ${entry.path}${trail.length ? ` › ${trail.join(" › ")}` : ""}`, block: component.id, subsystem: trail });
								if (component.params?.diagram?.components) visit(component.params.diagram.components, [...trail, component.id]);
							}
						};
						visit(diagram.components, []);
					} catch {
						// Not a readable diagram.
					}
				}
			}
			return results.slice(0, limit);
		},
	};

	async function toTrash(item) {
		const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
		await store.put({ ...item, key: `t/${id}`, id, deleted: new Date().toISOString() });
		return id;
	}
	return api;
}

// ---- HTTP.

const reply = (status, value, headers = {}) => {
	const raw = typeof value === "string" || value instanceof Uint8Array;
	return new Response(status === 304 || status === 204 ? null : raw ? value : JSON.stringify(value), { status, headers: { ...(raw ? {} : { "Content-Type": "application/json; charset=utf-8" }), "Cache-Control": "no-store", ...headers } });
};
const extension = path => (/\.[^./]+$/.exec(path)?.[0] ?? "").toLowerCase();
const noPackages = () => reply(422, { error: "Building and deploying packages needs the desktop app (npm start). This demo runs in your browser only.", log: [] });

async function handle(request) {
	const url = new URL(request.url);
	const route = `${request.method} /api/${url.pathname.slice(PREFIX.length)}`;
	const q = name => url.searchParams.get(name) ?? "";
	const json = async () => {
		const text = await request.text();
		try {
			return text ? JSON.parse(text) : {};
		} catch {
			throw new WorkspaceError("Bad JSON");
		}
	};
	const ws = await workspace();
	switch (route) {
		case "GET /api/info":
			return reply(200, { app: "connviews", version: APP_VERSION, workspace: "This browser (IndexedDB)", demo: true, watching: false });
		case "GET /api/projects":
			return reply(200, { projects: await ws.listProjects() });
		case "POST /api/projects": {
			const { name, description, diagrams, files } = await json();
			return reply(201, await ws.createProject(name, { description, diagrams, files }));
		}
		case "POST /api/projects/rename": {
			const { name, to } = await json();
			return reply(200, await ws.renameProject(name, to));
		}
		case "POST /api/projects/delete":
			return reply(200, await ws.deleteProject((await json()).name));
		case "GET /api/tree":
			return reply(200, { entries: await ws.tree(q("project")) });
		case "GET /api/file": {
			const file = await ws.readFile(q("project"), q("path"));
			if (request.headers.get("if-none-match") === `"${file.version}"`) return reply(304, null, { ETag: `"${file.version}"` });
			const headers = { "Content-Type": TYPES[extension(q("path"))] ?? "application/octet-stream", ETag: `"${file.version}"`, "X-Version": file.version, "Cache-Control": "no-cache", "Accept-Ranges": "bytes" };
			const bytes = new Uint8Array(file.bytes);
			const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
			if (range && (range[1] !== "" || range[2] !== "")) {
				const size = bytes.length;
				const start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
				const end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(size - 1, Number(range[2]));
				if (start >= size || start > end) return reply(416, null, { "Content-Range": `bytes */${size}` });
				return reply(206, bytes.slice(start, end + 1), { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` });
			}
			return reply(200, bytes, headers);
		}
		case "PUT /api/file":
			return reply(200, await ws.writeFile(q("project"), q("path"), new Uint8Array(await request.arrayBuffer()), { ifVersion: request.headers.get("x-if-version") || undefined }));
		case "POST /api/mkdir": {
			const { project, path } = await json();
			return reply(200, await ws.makeFolder(project, path));
		}
		case "POST /api/move": {
			const { project, from, to } = await json();
			return reply(200, await ws.move(project, from, to));
		}
		case "POST /api/copy": {
			const { project, from, to } = await json();
			return reply(200, await ws.copy(project, from, to));
		}
		case "POST /api/delete": {
			const { project, path } = await json();
			return reply(200, await ws.remove(project, path));
		}
		case "GET /api/trash":
			return reply(200, { items: await ws.listTrash() });
		case "POST /api/trash/restore":
			return reply(200, await ws.restore((await json()).id));
		case "GET /api/session":
			return reply(200, { session: await ws.readSession() });
		case "PUT /api/session":
			return reply(200, await ws.writeSession(await json()));
		case "GET /api/search":
			return reply(200, { results: await ws.search(q("q"), { project: q("project") || undefined }) });
		case "GET /api/toolchains":
			return reply(200, { tools: {} });
		case "POST /api/build":
		case "POST /api/deploy":
		case "POST /api/build/run":
		case "POST /api/deployment":
			return noPackages();
		// Back to back builds the generated program with a compiler on the computer.
		case "GET /api/workspace/deployments":
			return reply(200, { entries: [] });
		// Nothing is built or started in the browser: no live status.
		case "POST /api/deployment/status":
			return reply(200, { entries: [] });
		case "POST /api/harness/back-to-back":
		case "POST /api/harness/board":
		case "POST /api/board/info":
		case "POST /api/attach/info":
			return reply(422, { error: "Back to back builds and runs the generated program: it needs the desktop app (npm start). Run all runs the cases here, on the engine." });
		case "GET /api/services":
			return reply(200, { services: [] });
		case "POST /api/services/stop":
			return reply(200, {});
		default:
			return reply(404, { error: `No API ${route}` });
	}
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
// GitHub Pages cannot send headers: the app's own files pass through here and get the cross-origin isolation headers
// the Node server sends (onnxruntime's WebAssembly threads need SharedArrayBuffer). Opaque responses stay as they are.
const ISOLATION = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" };
function isolated(response) {
	if (!response || response.status === 0 || response.type === "opaque" || response.type === "opaqueredirect") return response;
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(ISOLATION)) headers.set(name, value);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener("fetch", event => {
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin) return;
	if (!url.pathname.startsWith(PREFIX)) {
		if (event.request.method !== "GET" || (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin")) return;
		event.respondWith(fetch(event.request).then(isolated));
		return;
	}
	event.respondWith(handle(event.request).catch(error => reply(error instanceof WorkspaceError ? error.status : 500, { error: error.message })));
});
