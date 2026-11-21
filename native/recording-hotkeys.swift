struct RecordingHotkeys {
    enum Action: Equatable {
        case forward, consume, togglePause, requestStop, releaseStop

        var consumesEvent: Bool { self != .forward }
    }

    // ANSI virtual key codes, independent of the character produced by the layout.
    private enum Key: Int {
        case stop = 7
        case pause = 35
    }

    private var held: Set<Key> = []

    mutating func route(code: Int, down: Bool, matchesChord: Bool, repeating: Bool) -> Action {
        guard let key = Key(rawValue: code) else { return .forward }
        if !down {
            guard held.remove(key) != nil else { return .forward }
            return key == .stop ? .releaseStop : .consume
        }
        if held.contains(key) { return .consume }
        guard matchesChord else { return .forward }
        if repeating { return .consume }
        held.insert(key)
        return key == .stop ? .requestStop : .togglePause
    }
}
