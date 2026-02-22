'use client';
import React from 'react';
import {
  TimeField as AriaTimeField,
  TimeFieldProps as AriaTimeFieldProps,
  TimeValue,
  ValidationResult
} from 'react-aria-components';
import { DateInput } from '@/components/ui/DateField';
import { Description, FieldError, Label } from '@/components/ui/Field';
import { composeTailwindRenderProps } from '@/lib/react-aria-utils';

export interface TimeFieldProps<T extends TimeValue>
  extends AriaTimeFieldProps<T> {
  label?: string;
  description?: string;
  errorMessage?: string | ((validation: ValidationResult) => string);
}

export function TimeField<T extends TimeValue>(
  { label, description, errorMessage, ...props }: TimeFieldProps<T>
) {
  return (
    <AriaTimeField {...props} className={composeTailwindRenderProps(props.className, 'flex flex-col gap-1 font-sans')}>
      <Label>{label}</Label>
      <DateInput />
      {description && <Description>{description}</Description>}
      <FieldError>{errorMessage}</FieldError>
    </AriaTimeField>
  );
}
