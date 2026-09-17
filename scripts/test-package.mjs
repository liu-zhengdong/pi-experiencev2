import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Run from the repository root. All runtime imports below come from the installed tarball.
const metadata = JSON.parse(await readFile("package.json", "utf8"));
await mkdir("release", { recursive: true });
const tarball = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(
      "release",
      Object.values(
        JSON.parse(
          execFileSync(
            "npm",
            [
              "pack",
              "--ignore-scripts",
              "--json",
              "--pack-destination",
              "release",
            ],
            { encoding: "utf8" },
          ),
        ),
      )[0].filename,
    );
const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter((file) => !file.endsWith("/"));
for (const file of files) {
  assert.match(
    file,
    /^package\/(?:dist\/[^/]+\.(?:js|d\.ts)|dist\/web\/app\.js|web\/(?:index\.html|style\.css)|examples\/vault\/.+\.md|docs\/.+\.md|(?:README(?:-Evolution)?|DESIGN(?:-Evolution)?)\.md|package\.json)$/,
    `Unexpected package file: ${file}`,
  );
}
for (const file of ["package.json", "dist/index.js", "dist/index.d.ts"]) {
  assert(files.includes(`package/${file}`), `Missing package file: ${file}`);
}
const sandbox = await mkdtemp(join(tmpdir(), "pi-package-smoke-"));
try {
  await writeFile(
    join(sandbox, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
      "@earendil-works/pi-coding-agent@0.85.1",
      "@earendil-works/pi-ai@0.85.1",
      "@earendil-works/pi-tui@0.85.1",
    ],
    { cwd: sandbox, stdio: "inherit", timeout: 180_000 },
  );
  const installed = join(sandbox, "node_modules", metadata.name);
  const manifest = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, metadata.name);
  assert.equal(manifest.version, metadata.version);
  assert.deepEqual(manifest.pi.extensions, ["./dist/index.js"]);
  const entry = join(installed, "dist/index.js");
  assert.equal(
    typeof (await import(pathToFileURL(entry).href)).default,
    "function",
  );
  const cwd = join(sandbox, "workspace");
  const agentDir = join(sandbox, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { DefaultResourceLoader } = await import(
    pathToFileURL(
      join(
        sandbox,
        "node_modules/@earendil-works/pi-coding-agent/dist/index.js",
      ),
    ).href
  );
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [installed],
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const extension = result.extensions.find(
    (item) => resolve(item.resolvedPath) === entry,
  );
  assert(extension, "Packed Pi extension was not loaded");
  const commands = {
    "@liuser/pi-notes": "notes",
    "pi-experiencev2": "runs",
    "pi-context-trace": "trace",
  };
  assert(extension.commands.has(commands[metadata.name]));
  if (metadata.name === "pi-experiencev2") {
    for (const tool of ["find_run", "get_message_detail", "delete_run"])
      assert(extension.tools.has(tool));
  }
  if (metadata.name === "pi-context-trace") {
    const { TraceStore } = await import(
      pathToFileURL(join(installed, "dist/store.js")).href
    );
    const { startViewer } = await import(
      pathToFileURL(join(installed, "dist/server.js")).href
    );
    const store = new TraceStore(join(sandbox, "trace.sqlite"));
    const viewer = await startViewer(
      store,
      () => ({
        enabled: false,
        sessionId: "smoke",
        revision: 0,
        error: null,
        pending: 0,
      }),
      0,
    );
    try {
      for (const [path, type, marker] of [
        ["/", "text/html", "app.js"],
        ["/style.css", "text/css", "{"],
        ["/app.js", "text/javascript", "api/"],
      ]) {
        const response = await fetch(`${viewer.url}${path}`);
        assert.equal(response.status, 200, `Missing packed asset: ${path}`);
        assert(response.headers.get("content-type").includes(type));
        assert((await response.text()).includes(marker));
      }
      assert.equal(
        (
          await fetch(`${viewer.url}/`, {
            headers: { origin: "https://example.com" },
          })
        ).status,
        403,
      );
    } finally {
      await viewer.close();
      store.close();
    }
  }
  console.log(
    JSON.stringify(
      {
        package: `${metadata.name}@${metadata.version}`,
        tarball,
        commands: [...extension.commands.keys()],
        tools: [...extension.tools.keys()],
        files: files.length,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
