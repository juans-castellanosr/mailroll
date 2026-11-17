export type OptionalField<K extends string, V> = Partial<Readonly<Record<K, V>>>;

export function optionalField<K extends string, V>(key: K, value: V | undefined): OptionalField<K, V> {
  return value === undefined ? {} : ({ [key]: value } as OptionalField<K, V>);
}
