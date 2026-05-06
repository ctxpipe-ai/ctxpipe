"use client"
import type React from "react"
import type { DisclosureGroupProps as AriaDisclosureGroupProps } from "react-aria-components"
import { DisclosureGroup as AriaDisclosureGroup } from "react-aria-components"

export interface DisclosureGroupProps extends AriaDisclosureGroupProps {
  children: React.ReactNode
}

export function DisclosureGroup({ children, ...props }: DisclosureGroupProps) {
  return <AriaDisclosureGroup {...props}>{children}</AriaDisclosureGroup>
}
