import "./load-dotenv.js"
import { parseEnv } from "../config/env.js"
import { installChatOpenAiGenAiSpans } from "./genAiChat.js"
import { initEvlog } from "./logger.js"
import { initOtel } from "./otel.js"

const env = parseEnv(process.env as Record<string, string | undefined>)
initOtel(env)
initEvlog()
installChatOpenAiGenAiSpans()
