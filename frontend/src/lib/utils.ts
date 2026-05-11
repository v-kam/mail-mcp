// shadcn/ui's standard `cn` helper.
//
// Combines class strings (clsx) and de-duplicates conflicting Tailwind
// classes (tailwind-merge), e.g. `cn("p-2", "p-4") === "p-4"`. Used by
// every component in `components/ui/*` to merge author overrides with
// the variant defaults.

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
