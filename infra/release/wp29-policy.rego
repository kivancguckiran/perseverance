package main

import rego.v1

deny contains message if {
  some command in input
  command.Cmd == "from"
  base := command.Value[0]
  not contains(base, "@sha256:")
  message := sprintf("base image is not digest pinned: %s", [base])
}

deny contains message if {
  some command in input
  lower(command.Cmd) == "user"
  lower(concat("", command.Value)) == "root"
  message := "runtime USER root is forbidden"
}
