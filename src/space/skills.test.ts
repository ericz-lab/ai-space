import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appSkills, collectSkills, describeSkillLinks, linkSkills, listSkills, skillLinkDir } from "./skills.ts";

async function skill(dir: string, name: string): Promise<string> {
  const d = join(dir, name);
  await Bun.write(join(d, "SKILL.md"), `---\nname: ${name}\n---\n`);
  return d;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "space-skills-"));
  const home = join(root, "ws");
  const shared = join(root, "core", "skills");
  await skill(shared, "notify");
  await skill(shared, "space-app");
  const video = join(home, "apps", "video-digest");
  await skill(join(video, "skills"), "youtube-summarizer");
  await skill(join(video, "skills"), "find-video-clip");
  const why = join(home, "apps", "whymove");
  await skill(join(why, ".claude", "skills"), "news-search");
  await skill(join(why, ".claude", "skills"), "notify"); // collides with the shared skill
  await mkdir(join(why, ".claude", "skills", "not-a-skill"), { recursive: true });
  return { root, home, shared, video, why };
}

async function links(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: dir, onlyFiles: false }))).sort()) {
    const path = join(dir, name);
    out[name] = (await lstat(path)).isSymbolicLink() ? await readlink(path) : "<dir>";
  }
  return out;
}

describe("skills", () => {
  test("listSkills and appSkills only see directories with a SKILL.md", async () => {
    const f = await fixture();
    expect((await listSkills(f.shared)).map((d) => d.split("/").pop())).toEqual(["notify", "space-app"]);
    expect(await listSkills(join(f.root, "missing"))).toEqual([]);
    expect((await appSkills(f.why)).map((d) => d.split("/").pop())).toEqual(["news-search", "notify"]);
    // skills/ wins over .claude/skills/ for the same name
    await skill(join(f.why, "skills"), "news-search");
    expect(await appSkills(f.why)).toEqual([join(f.why, "skills", "news-search"), join(f.why, ".claude", "skills", "notify")]);
  });

  test("collectSkills names shared first and prefixes an app's colliding skill", async () => {
    const f = await fixture();
    const { sources, renamed } = await collectSkills(f.shared, [f.video, f.why]);
    expect(sources.map((s) => `${s.owner}:${s.name}`)).toEqual([
      "space:notify",
      "space:space-app",
      "video-digest:find-video-clip",
      "video-digest:youtube-summarizer",
      "whymove:news-search",
      "whymove:whymove-notify",
    ]);
    expect(renamed).toEqual([{ owner: "whymove", skill: "notify", name: "whymove-notify" }]);
  });

  test("linkSkills creates, keeps, removes and reports links", async () => {
    const f = await fixture();
    const dir = skillLinkDir(f.home);
    const first = await linkSkills(f.home, f.shared, [f.video, f.why]);
    expect(first.dir).toBe(dir);
    expect(await links(dir)).toEqual({
      "find-video-clip": join(f.video, "skills", "find-video-clip"),
      "news-search": join(f.why, ".claude", "skills", "news-search"),
      notify: join(f.shared, "notify"),
      "space-app": join(f.shared, "space-app"),
      "whymove-notify": join(f.why, ".claude", "skills", "notify"),
      "youtube-summarizer": join(f.video, "skills", "youtube-summarizer"),
    });
    expect(describeSkillLinks(first)).toBe(`6 skills linked (2 shared, 4 from 2 apps) in ${dir}; whymove/notify linked as whymove-notify (name taken)`);

    // A second pass changes nothing.
    const again = await linkSkills(f.home, f.shared, [f.video, f.why]);
    expect(again.removed).toEqual([]);
    expect(await links(dir)).toEqual(await links(dir));

    // An app leaves, a skill is deleted: their links go; the user's own entries stay.
    await rm(join(f.video, "skills", "find-video-clip"), { recursive: true });
    const mine = await skill(join(f.root, "mine"), "my-skill");
    await symlink(mine, join(dir, "my-skill"));
    await mkdir(join(dir, "real-dir"));
    const third = await linkSkills(f.home, f.shared, [f.video]);
    expect(third.removed.sort()).toEqual(["find-video-clip", "news-search", "whymove-notify"]);
    expect(Object.keys(await links(dir)).sort()).toEqual(["my-skill", "notify", "real-dir", "space-app", "youtube-summarizer"]);
    expect(describeSkillLinks(third)).toContain("3 skills linked (2 shared, 1 from 1 app)");

    // A user's link or directory with a skill's name is not replaced.
    await skill(join(f.video, "skills"), "my-skill");
    await skill(join(f.video, "skills"), "real-dir");
    const fourth = await linkSkills(f.home, f.shared, [f.video]);
    expect(fourth.removed).toEqual([]);
    expect((await links(dir))["my-skill"]).toBe(mine);
    expect((await links(dir))["real-dir"]).toBe("<dir>");
  });

  test("linkSkills works without a shared directory and with no apps", async () => {
    const home = join(await mkdtemp(join(tmpdir(), "space-skills-")), "ws");
    const r = await linkSkills(home, undefined, []);
    expect(r.linked).toEqual([]);
    expect(await links(r.dir)).toEqual({});
    expect(describeSkillLinks(r)).toBe(`0 skills linked (0 shared, 0 from 0 apps) in ${r.dir}`);
  });
});
