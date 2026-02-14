import { generateLangGraphConfig, writeLangGraphConfig } from "./config.js"

/**
 * Starts the LangGraph dev server as a subprocess.
 * Generates langgraph.json before spawning.
 * Runs the CLI with Node (not Bun) so CJS deps resolve correctly.
 */
export function startLangSmithSubprocess(): void {
	const config = generateLangGraphConfig()
	writeLangGraphConfig(config)

	const cwd = process.cwd()
	const subprocess = Bun.spawn(
		[
			"npx",
			"-y",
			"@langchain/langgraph-cli",
			"dev",
			"--port",
			"2024",
			"--no-browser",
		],
		{
			cwd,
			stdio: ["ignore", "inherit", "inherit"],
			env: { ...process.env },
		},
	)

	process.on("SIGTERM", () => subprocess.kill())
	process.on("SIGINT", () => subprocess.kill())
}
