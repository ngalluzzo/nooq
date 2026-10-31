/** Other packages install Happy DOM globals. Exercise the CLI's native Bun environment. */
export async function isolated<T>(code: string, input: unknown): Promise<T> {
  const child = Bun.spawn([process.execPath, "-e", code], { cwd: import.meta.dir, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify(input)); child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  try {
    const [output, errors, status] = await Promise.all([Bun.readableStreamToText(child.stdout), Bun.readableStreamToText(child.stderr), child.exited]);
    if (status) throw new Error(errors || `Check process exited ${status}`);
    return JSON.parse(output);
  } finally { clearTimeout(timer); }
}
