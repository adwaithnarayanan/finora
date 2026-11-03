/** A radio choice drawn as a bordered card. Uncontrolled: the form reset after a submission restores `defaultChecked`. */
export function RadioCard({
  name,
  value,
  label,
  hint,
  defaultChecked,
  onChange,
}: {
  name: string;
  value: string;
  label: string;
  hint: string;
  defaultChecked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm has-checked:border-primary has-checked:bg-muted/60 has-focus-visible:ring-2 has-focus-visible:ring-ring">
      <input type="radio" name={name} value={value} defaultChecked={defaultChecked} onChange={onChange} className="mt-0.5" />
      <span>
        <span className="block font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
