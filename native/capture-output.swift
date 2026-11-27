import Foundation

/// The helper's output pipe, written off the tap callback.
///
/// A callback that blocks in `write` because the engine is still parsing the
/// previous line — or because it is waiting on a window read — is exactly the
/// callback the system disables. So the callback only appends the line, and a
/// serial queue owns the pipe: a reader that is behind slows the writer, never
/// the tap. Order is preserved because every line is appended under the same
/// lock and drained by one queue in arrival order.
final class LineWriter {
    private let lock = NSLock()
    private var pending: [Data] = []
    private let queue = DispatchQueue(label: "cuekeeper.capture.output", qos: .utility)
    private let sink: (Data) -> Void

    /// `sink` is injectable so the offline test can read the stream back in the
    /// order it was produced.
    init(sink: @escaping (Data) -> Void = { FileHandle.standardOutput.write($0) }) {
        self.sink = sink
    }

    /// Queues one line. Never blocks on the reader.
    func append(_ line: Data) {
        lock.lock()
        pending.append(line)
        lock.unlock()
        queue.async { [weak self] in self?.drain() }
    }

    /// Writes everything still queued, after any drain already running. Only a
    /// session that is ending uses it: the tap is gone and the last lines have to
    /// reach the engine before the process exits.
    func flush() {
        queue.sync { drain() }
    }

    private func drain() {
        lock.lock()
        var batch = pending
        pending.removeAll()
        lock.unlock()
        while !batch.isEmpty {
            for line in batch { sink(line) }
            lock.lock()
            batch = pending
            pending.removeAll()
            lock.unlock()
        }
    }
}
