import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SiteCrawl — HTML + CSS snapshot",
  description: "Fetch a page and download it with its stylesheets inlined.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
