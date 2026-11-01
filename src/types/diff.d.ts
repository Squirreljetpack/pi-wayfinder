declare module "diff" {
  export interface ArrayChange<T> {
    count?: number;
    added?: boolean;
    removed?: boolean;
    value: T[];
  }

  export interface TextChange {
    count?: number;
    added?: boolean;
    removed?: boolean;
    value: string;
  }

  export function diffArrays<T>(oldArray: T[], newArray: T[]): ArrayChange<T>[];
  export function diffLines(oldStr: string, newStr: string): TextChange[];
  export function createTwoFilesPatch(
    oldFileName: string,
    newFileName: string,
    oldStr: string,
    newStr: string,
    oldHeader?: string,
    newHeader?: string,
    options?: { context?: number },
  ): string;

  export function createPatch(
    fileName: string,
    oldStr: string,
    newStr: string,
    oldHeader?: string,
    newHeader?: string,
    options?: { context?: number },
  ): string;

  export function applyPatch(
    source: string,
    patch: string,
    options?: { fuzzFactor?: number },
  ): string | false;
}
