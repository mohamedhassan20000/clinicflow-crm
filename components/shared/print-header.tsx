import { MapPin, Phone } from "lucide-react";

interface PrintHeaderProps {
  clinicName: string;
  clinicAddress?: string | null;
  clinicPhone?: string | null;
  logoUrl?: string | null;
  documentName: string;
  generatedAt: string;
}

export function PrintHeader({
  clinicName,
  clinicAddress,
  clinicPhone,
  logoUrl,
  documentName,
  generatedAt,
}: PrintHeaderProps) {
  return (
    <>
      {/* Compact header — fixed, repeats on every printed page (page 2+) */}
      <div className="print-compact-header hidden">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            {logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt=""
                aria-hidden
                style={{ height: "22px", width: "auto", objectFit: "contain", flexShrink: 0 }}
              />
            )}
            <span style={{ fontSize: "11px", fontWeight: 600 }}>{clinicName}</span>
          </div>
          <span style={{ fontSize: "10px", color: "#64748b" }}>{documentName}</span>
        </div>
        <div style={{ borderBottom: "1px solid #cbd5e1", marginTop: "4px" }} />
      </div>

      {/* Full header — inline, naturally on page 1; covers compact header via higher z-index */}
      <div
        className="print-full-header hidden print:block"
        style={{ borderBottom: "1px solid #cbd5e1", paddingBottom: "10px", marginBottom: "0" }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            {logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt=""
                aria-hidden
                style={{ height: "88px", width: "auto", objectFit: "contain", flexShrink: 0 }}
              />
            )}
            <div>
              <p style={{ fontSize: "14px", fontWeight: 600, lineHeight: 1.2 }}>
                {clinicName}
              </p>
              {clinicAddress && (
                <p
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "3px",
                    fontSize: "10px",
                    color: "#64748b",
                    marginTop: "3px",
                  }}
                >
                  <MapPin size={9} aria-hidden />
                  {clinicAddress}
                </p>
              )}
              {clinicPhone && (
                <p
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "3px",
                    fontSize: "10px",
                    color: "#64748b",
                    marginTop: "2px",
                  }}
                >
                  <Phone size={9} aria-hidden />
                  {clinicPhone}
                </p>
              )}
            </div>
          </div>
          <div style={{ textAlign: "right", fontSize: "10px", color: "#64748b" }}>
            <p>Generated {generatedAt}</p>
          </div>
        </div>
      </div>
    </>
  );
}
