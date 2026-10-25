import Image from "next/image";

/** The Veristart logo for headers (light blue, transparent: for the dark header and sidebar). */
export function BrandLogo({ height = 22 }: { height?: number }) {
  return <Image src="/veristart-logo.png" alt="Veristart" width={Math.round((574 / 96) * height)} height={height} priority />;
}

/** Just the "V" badge, for the collapsed sidebar. */
export function BrandMark({ height = 26 }: { height?: number }) {
  return <Image src="/veristart-mark.png" alt="Veristart" width={Math.round((78 / 96) * height)} height={height} priority />;
}
