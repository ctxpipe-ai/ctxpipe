"use client"
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react"
import {
  CalendarGridHeader as AriaCalendarGridHeader,
  CalendarHeaderCell,
  Heading,
  useLocale,
} from "react-aria-components"
import { Button } from "@/components/ui/Button"

export function CalendarHeader() {
  const { direction } = useLocale()

  return (
    <header className="flex items-center gap-1 pb-4 px-1 border-box">
      <Button variant="quiet" size="icon-sm" slot="previous">
        {direction === "rtl" ? (
          <IconChevronRight aria-hidden size={18} />
        ) : (
          <IconChevronLeft aria-hidden size={18} />
        )}
      </Button>
      <Heading className="flex-1 font-sans font-semibold [font-variation-settings:normal] text-base text-center mx-2 my-0 text-neutral-900 dark:text-neutral-200" />
      <Button variant="quiet" size="icon-sm" slot="next">
        {direction === "rtl" ? (
          <IconChevronLeft aria-hidden size={18} />
        ) : (
          <IconChevronRight aria-hidden size={18} />
        )}
      </Button>
    </header>
  )
}

export function CalendarGridHeader() {
  return (
    <AriaCalendarGridHeader>
      {(day) => (
        <CalendarHeaderCell className="text-xs text-neutral-500 font-semibold">
          {day}
        </CalendarHeaderCell>
      )}
    </AriaCalendarGridHeader>
  )
}
