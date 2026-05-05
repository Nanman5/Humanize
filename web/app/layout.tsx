import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Humanize",
  description: "Reduce huellas de detección de IA en imágenes",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
