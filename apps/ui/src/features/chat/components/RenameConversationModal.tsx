import { Button } from "@/components/ui/Button"
import { Form } from "@/components/ui/Form"
import { TextField } from "@/components/ui/TextField"
import { useState } from "react"

export function RenameConversationModal({
  conversationName,
  onClose,
  onSubmit,
  isPending,
  error,
}: {
  conversationName: string
  onClose: () => void
  onSubmit: (name: string) => void
  isPending: boolean
  error: string | undefined
}) {
  const [name, setName] = useState(conversationName)
  const [touched, setTouched] = useState(false)

  const nameError = touched && !name.trim() ? "Name is required" : undefined
  const isValid = name.trim().length > 0

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    const trimmed = name.trim()
    if (trimmed) onSubmit(trimmed)
  }

  return (
    <Form
      onSubmit={handleSubmit}
      className="flex flex-col gap-5 p-6 text-zinc-100"
    >
      <h2 className="text-lg font-semibold text-zinc-100">
        Rename conversation
      </h2>
      {error && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
      <TextField
        label="Name"
        value={name}
        onChange={(value) => {
          setName(value)
          setTouched(true)
        }}
        placeholder="Conversation name"
        isRequired
        errorMessage={nameError}
        isInvalid={!!nameError}
        autoFocus
        className="[&_input]:bg-zinc-800 [&_input]:text-zinc-100 [&_input]:rounded-md [&_input]:border [&_input]:border-zinc-700 [&_input]:placeholder:text-zinc-500 [&_label]:text-zinc-300"
      />
      <div className="flex justify-end gap-2 pt-2">
        <Button
          variant="quiet"
          onPress={onClose}
          type="button"
          className="!text-zinc-400 hover:!text-teal-500"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          isDisabled={isPending || !isValid}
          className="!bg-teal-500 !text-black hover:!bg-teal-600"
        >
          {isPending ? "Renaming…" : "Rename"}
        </Button>
      </div>
    </Form>
  )
}
