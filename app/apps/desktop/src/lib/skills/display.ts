// How a skill's name is SHOWN: with a leading slash, the way Claude lists
// skills ("/team-hello"). Display only: stored names, inputs, validation, API
// payloads and file paths never carry the slash.

export function skillDisplayName(name: string): string {
  return name.startsWith("/") ? name : `/${name}`;
}
