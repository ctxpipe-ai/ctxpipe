export async function acceptInvitationThenRedirect(
  acceptInvitation: () => Promise<unknown>,
  redirect: () => void,
): Promise<void> {
  await acceptInvitation()
  redirect()
}
