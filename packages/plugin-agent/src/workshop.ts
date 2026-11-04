import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBrief } from "./brief.ts";
import {
  candidatePaths,
  contextSections,
  contractFingerprint,
  scaffoldPackage,
  type Sources,
} from "./sources.ts";
import { writeArtifacts } from "./artifacts.ts";
import { validatePackage, type Stage } from "./check.ts";

/** nooq's domain contribution. Execution, persistence, authority and UI belong to Gooi. */
export default {
  id: "nooq.block-plugin/2",
  title: "nooq Plugin Workshop",
  paths: candidatePaths,
  fingerprint: contractFingerprint,
  exportArtifacts: async (
    directory: string,
    brief: unknown,
    validation: unknown,
    report: object,
  ) =>
    writeArtifacts(
      directory,
      parseBrief(brief),
      validation as Awaited<ReturnType<typeof validatePackage>>,
      report,
    ),
  async prepare(input: unknown) {
    const brief = parseBrief(input);
    if (!brief.view || !brief.insertCommand)
      throw Error("A complete-plugin brief is required");
    return {
      brief,
      files: scaffoldPackage(brief),
      api: await contextSections(),
    };
  },
  async validate(input: {
    brief: unknown;
    files: Record<string, string>;
    stage: Stage;
    contract: string;
  }) {
    const directory = await mkdtemp(join(tmpdir(), "nooq-workshop-oracle-"));
    try {
      const validation = await validatePackage(
        input.files as Sources,
        parseBrief(input.brief),
        { stage: input.stage, artifactDir: directory },
      );
      const artifacts: {
        name: string;
        mediaType: string;
        digest: string;
        chunks: string[];
      }[] = [];
      for (const [name, mediaType] of [
        ["preview.html", "text/html"],
        ["preview.png", "image/png"],
      ]) {
        let bytes: Buffer;
        try {
          bytes = await readFile(join(directory, name!));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const encoded = bytes.toString("base64");
        artifacts.push({
          name: name!,
          mediaType: mediaType!,
          digest: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`,
          chunks: encoded.match(/.{1,60000}/g) ?? [],
        });
      }
      const details = JSON.parse(JSON.stringify(validation));
      if (details.browser?.screenshot)
        details.browser.screenshot = "preview.png";
      return {
        complete: validation.complete,
        stage: input.stage,
        contract: input.contract,
        gates: validation.gates,
        details,
        artifacts,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
};
