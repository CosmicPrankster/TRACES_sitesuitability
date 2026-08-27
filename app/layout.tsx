import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hydrocyclone + Membrane Site Screening",
  description:
    "Enter a site. Get a screening of which hydrocyclone and membrane combinations are worth investigating.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
