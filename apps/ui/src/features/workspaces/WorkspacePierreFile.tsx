import type { FileContents } from "@pierre/diffs"
import { parseDiffFromFile } from "@pierre/diffs"
import { Editor } from "@pierre/diffs/edit"
import { EditProvider, File, FileDiff } from "@pierre/diffs/react"
import { useMemo, useRef } from "react"

const FILE_UNSAFE_CSS = `
  :host {
    display: block;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }
  pre {
    display: block;
    height: 100%;
    min-height: 0;
    overflow: auto;
  }
  pre::-webkit-scrollbar {
    width: var(--diffs-scrollbar-gutter);
    height: var(--diffs-scrollbar-gutter);
  }
  [data-code] {
    contain: none;
    align-self: start;
    height: auto;
    min-height: auto;
    min-width: 100%;
    width: max-content;
    overflow: visible;
    grid-auto-rows: max-content;
  }
`

const FILE_OPTIONS = {
  theme: { dark: "pierre-dark" as const, light: "pierre-light" as const },
  disableFileHeader: true,
  overflow: "scroll" as const,
  unsafeCSS: FILE_UNSAFE_CSS,
}

const DIFF_OPTIONS = {
  ...FILE_OPTIONS,
  diffStyle: "unified" as const,
}

function createPierreEditor(options: ConstructorParameters<typeof Editor>[0]) {
  return new Editor(options)
}

export type FileEditorHistory = {
  canUndo: boolean
  canRedo: boolean
}

export type FileEditorHandle = {
  undo: () => void
  redo: () => void
}

export function WorkspacePierreFile(props: {
  path: string
  body: string
  cacheKey: string
  oldBody?: string | null
  editable?: boolean
  onChange?: (body: string) => void
  onBlur?: () => void
  onHistoryChange?: (history: FileEditorHistory) => void
  editorHandleRef?: { current: FileEditorHandle | null }
}) {
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange
  const onBlurRef = useRef(props.onBlur)
  onBlurRef.current = props.onBlur
  const onHistoryChangeRef = useRef(props.onHistoryChange)
  onHistoryChangeRef.current = props.onHistoryChange
  const editorRef = useRef<Editor | null>(null)
  const editorHandleOutRef = useRef(props.editorHandleRef)
  editorHandleOutRef.current = props.editorHandleRef
  const editorOptions = useMemo(() => {
    const reportHistory = () => {
      const editor = editorRef.current
      if (!editor) return
      onHistoryChangeRef.current?.({
        canUndo: editor.canUndo,
        canRedo: editor.canRedo,
      })
    }
    return {
      persistState: true,
      onAttach: (editor: Editor) => {
        editorRef.current = editor
        const handleOut = editorHandleOutRef.current
        if (handleOut) {
          handleOut.current = {
            undo: () => {
              editor.undo()
              reportHistory()
            },
            redo: () => {
              editor.redo()
              reportHistory()
            },
          }
        }
        reportHistory()
      },
      onChange: (file: FileContents) => {
        onChangeRef.current?.(file.contents)
        reportHistory()
      },
      onBlur: () => {
        onBlurRef.current?.()
      },
    }
  }, [])
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
      options={DIFF_OPTIONS}
      disableWorkerPool
      className="block size-full min-h-0"
      edit={props.editable}
      editorOptions={props.editable ? editorOptions : undefined}
    />
  ) : (
    <File
      file={file}
      options={FILE_OPTIONS}
      disableWorkerPool
      className="block size-full min-h-0"
      edit={props.editable}
      editorOptions={props.editable ? editorOptions : undefined}
    />
  )

  const filled = (
    <div className="h-full min-h-0 min-w-0 overflow-hidden">{surface}</div>
  )
  if (!props.editable) return filled
  return (
    <div className="h-full min-h-0 min-w-0 overflow-hidden">
      <EditProvider createEditor={createPierreEditor}>{surface}</EditProvider>
    </div>
  )
}
