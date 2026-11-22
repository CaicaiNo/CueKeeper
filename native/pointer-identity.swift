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

enum PointerIdentityResolver {
    /// Roles that stand for the clicked item rather than for a wrapper.
    static let itemRoles: Set<String> = [
        "AXCell", "AXRow", "AXListItem", "AXOutlineRow", "AXTreeItem",
        "AXStaticText", "AXText", "AXImage", "AXLink",
    ]

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
