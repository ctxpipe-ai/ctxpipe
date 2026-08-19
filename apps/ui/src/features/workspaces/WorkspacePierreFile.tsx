import type { FileContents } from "@pierre/diffs"
import { parseDiffFromFile } from "@pierre/diffs"
import { Editor } from "@pierre/diffs/edit"
import { EditProvider, File, FileDiff } from "@pierre/diffs/react"
import { useMemo, useRef } from "react"

const FILE_OPTIONS = {
  theme: { dark: "pierre-dark" as const, light: "pierre-light" as const },
  disableFileHeader: true,
}

function createPierreEditor(options: ConstructorParameters<typeof Editor>[0]) {
  return new Editor(options)
}

export function WorkspacePierreFile(props: {
  path: string
  body: string
  cacheKey: string
  oldBody?: string | null
  editable?: boolean
  onChange?: (body: string) => void
}) {
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange
  const editorOptions = useMemo(
    () => ({
      persistState: true,
      onChange: (file: FileContents) => {
        onChangeRef.current?.(file.contents)
      },
    }),
    [],
  )
  const file = useMemo(
    () => ({
      name: props.path,
      contents: props.body,
      cacheKey: props.cacheKey,
    }),
    [props.path, props.body, props.cacheKey],
  )
  const oldFile = useMemo(() => {
    if (props.oldBody == null) return null
    return {
      name: props.path,
      contents: props.oldBody,
      cacheKey: `head:${props.cacheKey}`,
    }
  }, [props.path, props.oldBody, props.cacheKey])
  const showDiff = props.oldBody != null && props.oldBody !== props.body
  const fileDiff = useMemo(
    () => (showDiff ? parseDiffFromFile(oldFile, file) : null),
    [showDiff, oldFile, file],
  )

  const surface = fileDiff ? (
    <FileDiff
      fileDiff={fileDiff}
      options={FILE_OPTIONS}
      disableWorkerPool
      className="block h-full min-h-full"
      edit={props.editable}
      editorOptions={props.editable ? editorOptions : undefined}
    />
  ) : (
    <File
      file={file}
      options={FILE_OPTIONS}
      disableWorkerPool
      className="block h-full min-h-full"
      edit={props.editable}
      editorOptions={props.editable ? editorOptions : undefined}
    />
  )

  const filled = <div className="h-full min-h-full min-w-0">{surface}</div>
  if (!props.editable) return filled
  return (
    <div className="h-full min-h-full min-w-0">
      <EditProvider createEditor={createPierreEditor}>{surface}</EditProvider>
    </div>
  )
}
