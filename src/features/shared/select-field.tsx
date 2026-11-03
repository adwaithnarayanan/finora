import type { ReactNode } from "react";

import { NativeSelect } from "@/components/ui/native-select";

import { Field } from "./field";

/**
 * A labelled native select. It is uncontrolled: React applies `defaultValue`
 * only when the select mounts, so pass a `remountKey` that changes whenever the
 * select must show a new value (for example after a refused submission).
 */
export function SelectField({
  name,
  label,
  hint,
  error,
  options,
  placeholder,
  defaultValue,
  remountKey,
  onChange,
  required,
}: {
  name: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  options: readonly { value: string; label: string }[];
  /** Label of the empty first option; omitted when a value is always chosen. */
  placeholder?: string;
  defaultValue?: string;
  remountKey?: string | number;
  onChange?: (value: string) => void;
  required?: boolean;
}) {
  return (
    <Field name={name} label={label} hint={hint} error={error}>
      {(props) => (
        <NativeSelect
          {...props}
          key={remountKey}
          defaultValue={defaultValue}
          onChange={onChange ? (event) => onChange(event.target.value) : undefined}
          required={required}
        >
          {placeholder === undefined ? null : <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      )}
    </Field>
  );
}
