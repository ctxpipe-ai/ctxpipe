import { delay, HttpResponse } from "msw"

/**
 * The state of one mocked request: the data of a success, `"loading"` (the
 * request does not end) or `"error"` (500). A shared handler of an API area
 * takes a state, so that a story shows each request of its page as a
 * success, a load or an error (the storybook skill, "Mock every request").
 */
export type MockState<T> = T | "loading" | "error"

/** The response of a request in `state`. A success sends `ok(data)`. */
export async function mockResponse<T>(
  state: MockState<T>,
  ok: (data: T) => Response,
): Promise<Response> {
  if (state === "loading") await delay("infinite")
  if (state === "error" || state === "loading")
    return HttpResponse.json({ error: "Server error" }, { status: 500 })
  return ok(state)
}
