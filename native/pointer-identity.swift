import Foundation

/// What one element under the pointer can prove about itself.
struct PointerElement: Equatable {
    var role: String?
    var name: String?
}

/// The element a recorded click should name.
///
/// Finder puts a file's name on an enclosing cell or row, or on the static text
/// label beside its icon, while the innermost element under the pointer is
/// often an unnamed text field. Recording only that role loses which file was
/// clicked, and a replay then hits whatever unnamed field happens to be there.
struct PointerIdentity: Equatable {
    var role: String
    var name: String?
}

/// The file a click landed on, as the accessibility attributes describe it.
///
/// Finder's list view names a whole row by joining its columns ("今天 21:36 616
/// 字节 JSON"), so the row's own name is a description, never a file. The file
/// name comes from the filesystem attributes first and from the text field in
/// the row's first (name) column second.
enum PointerFileItem {
    static let maxNameLength = 256

    /// The display name of the file: AXFilename, then the file URL's last path
    /// component, then the name column's text. Nil when the item names no file,
    /// so the caller records a point instead of the column description.
    static func name(filename: String?, url: String?, column: String?) -> String? {
        for candidate in [filename, url, column] {
            guard let candidate else { continue }
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty && trimmed.count <= maxNameLength { return trimmed }
        }
        return nil
    }
}

enum PointerIdentityResolver {
    /// Roles that stand for the clicked item rather than for a wrapper.
    static let itemRoles: Set<String> = [
        "AXCell", "AXRow", "AXListItem", "AXOutlineRow", "AXTreeItem",
        "AXStaticText", "AXText", "AXImage", "AXLink",
    ]

    /// The driver's spelling for an item role. A window tree calls an outline
    /// row `treeitem`, so a target the helper named must use that spelling to
    /// be found again at replay.
    static func snapshotRole(_ role: String) -> String {
        role == "AXOutlineRow" ? "treeitem" : role
    }

    /// The hit names itself when it can. Otherwise the nearest named item above
    /// it does; a wrapper such as AXToolbar, AXGroup or AXWindow never does. A
    /// hit that names nothing keeps its role and no name, so the caller records
    /// a point instead of an address it cannot prove.
    static func resolve(hit: PointerElement, ancestors: [PointerElement]) -> PointerIdentity? {
        if let role = hit.role, let name = hit.name, !name.isEmpty {
            return PointerIdentity(role: role, name: name)
        }
        for ancestor in ancestors {
            guard let role = ancestor.role, itemRoles.contains(role),
                  let name = ancestor.name, !name.isEmpty else { continue }
            return PointerIdentity(role: role, name: name)
        }
        guard let role = hit.role, !role.isEmpty else { return nil }
        return PointerIdentity(role: role, name: nil)
    }
}
