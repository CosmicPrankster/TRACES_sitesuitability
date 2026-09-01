import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hydrocyclone + membrane screening",
  description: "Which hydrocyclone and membrane combinations are worth investigating, and why.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
