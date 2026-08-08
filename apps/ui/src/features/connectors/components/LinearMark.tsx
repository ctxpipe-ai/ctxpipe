type LinearMarkProps = {
  className?: string
}

export function LinearMark({ className }: LinearMarkProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <title>Linear</title>
      <path
        d="M4.2 14.2a8.2 8.2 0 0 0 5.6 5.6L4.2 14.2Zm-.4-4.4a8.2 8.2 0 0 0-.1 2.5l8 8a8.2 8.2 0 0 0 2.5-.1L3.8 9.8Zm1.5-3.2a8.2 8.2 0 0 0-.9 1.6l11.4 11.4a8.2 8.2 0 0 0 1.6-.9L5.3 6.6ZM12 3.8c-1.8 0-3.5.6-4.9 1.6l11.5 11.5A8.2 8.2 0 0 0 12 3.8Z"
        fill="currentColor"
      />
    </svg>
  )
}
