# A synthetic example for an installed Ark kernel.
measurements <- data.frame(sample = LETTERS[1:6], signal = c(2.4, 3.1, 2.8, 4.2, 3.8, 4.5))
plot(measurements$signal, type = "b", col = "#497e75", xlab = "Sample", ylab = "Signal (arbitrary units)", main = "Synthetic measurements")
measurements
